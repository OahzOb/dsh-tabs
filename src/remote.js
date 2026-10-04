'use strict'

/**
 * The remote half of dsh-tabs: everything that decides what to run on the far
 * side of an ssh connection.
 *
 * This module is a deliberate copy of the pure builders in the
 * `dsh-remote-devices` plugin (`plugins/dsh-remote-devices/index.js`). A
 * standalone application has to be self-contained — it cannot import from a
 * plugin directory the operator may delete — so the logic is duplicated rather
 * than shared, and `tools/smoke.mjs` asserts the two copies still agree. Drift
 * fails the suite instead of surfacing later as a mysterious connect failure.
 *
 * The comments are copied along with the code on purpose: they record why each
 * contract exists, and several of them were paid for with a real outage.
 */

const { join } = require('node:path')

/** The readiness line `dsh web` prints once its server is listening. */
const READY_LINE = /dsh web:\s*(http:\/\/\S+)/u

/** How long a remote `dsh web` may take to announce its URL. */
const START_TIMEOUT_MS = 45_000

/** How long a plain `ssh` probe may take. */
const PROBE_TIMEOUT_MS = 20_000

/** How long the tunnel may take to accept a local connection. */
const TUNNEL_TIMEOUT_MS = 20_000

/** Default SSH port. */
const DEFAULT_SSH_PORT = 22

/**
 * @typedef {object} Device
 * @property {string} id - stable identity, also the runtime-registry key.
 * @property {string} label - display name.
 * @property {string} transport - `ssh` today.
 * @property {string} host - SSH target host name or address.
 * @property {string} user - SSH user.
 * @property {number} sshPort - SSH port.
 * @property {string} [directory] - launch directory the remote `dsh web` starts in.
 * @property {'posix'|'windows'} [platform] - detected shell family, cached.
 */

/**
 * Find a readiness URL in accumulated output.
 *
 * Only **complete lines** are considered by default. The pattern ends in `\S+`,
 * which will happily match a URL that a pipe split mid-write, so matching the raw
 * buffer resolves with a truncated URL — a connect that succeeds or fails
 * depending on how the operating system happened to chunk the output, which is
 * the worst kind of intermittent. Reproduced by writing `http://127.0.0.` /
 * `1:42341/?tok` / `en=abc\n` in three chunks, which yielded the truncated URL
 * and a port of `NaN`.
 *
 * @param raw - everything the command has printed so far.
 * @param partialToo - also accept an unterminated trailing line, which is only
 *   safe once the process is known to have stopped printing.
 * @returns the URL, or null.
 */
function readyUrl(raw, partialToo = false) {
	const text = partialToo ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1)
	const match = READY_LINE.exec(text)
	return match === null ? null : match[1]
}

/**
 * Quote one string for a POSIX shell so it survives as a single word.
 * @param value - the raw string.
 * @returns the single-quoted form, safe for any content including quotes.
 */
function shellSingleQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`
}

/**
 * Make a bare `dsh` resolvable inside a NON-interactive login shell.
 *
 * This is not a nicety — it is load-bearing. A node installed through nvm puts
 * its bin directory on PATH from `~/.bashrc`, which bash sources only for
 * INTERACTIVE shells. `ssh host 'bash -lc "dsh --version"'` therefore fails with
 * `dsh: command not found` on an otherwise perfectly configured machine, while
 * the same command typed by hand works.
 *
 * `remoteCommand()` now asks for an interactive shell, which sources `~/.bashrc`
 * and solves this class of problem wholesale — the operator's own exports
 * (`DEEPSEEK_API_KEY`, proxy variables, PATH) all arrive as they do in a
 * terminal. This preamble is retained because it is free and covers the case
 * where a machine resolves `dsh` without any rc file's help.
 *
 * @returns one POSIX shell statement sequence.
 */
function resolvePreamble() {
	return [
		'command -v dsh >/dev/null 2>&1 || { [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; true; }',
		'command -v dsh >/dev/null 2>&1 || { for d in "$HOME"/.nvm/versions/node/*/bin "$HOME/.local/bin" /usr/local/bin; do [ -x "$d/dsh" ] && PATH="$d:$PATH" && break; done; true; }'
	].join('; ')
}

/**
 * Build the `cd` that enters a device's working directory.
 *
 * Tilde expansion is the entire reason this helper exists. `cd '~/x'` does NOT
 * work: the single quotes that make the path injection-safe also suppress the
 * expansion that turns `~` into `$HOME`, so the directory is looked up literally
 * and every device configured as `~/...` dies at startup with `No such file or
 * directory`. Splitting the tilde off and quoting only the remainder keeps both
 * the expansion and the safety.
 *
 * @param directory - the configured directory, `~`-relative or absolute.
 * @returns one `cd` statement.
 */
function remoteCd(directory) {
	if (directory === '~') return 'cd "$HOME"'
	if (directory.startsWith('~/') || directory.startsWith('~\\')) return `cd "$HOME"/${shellSingleQuote(directory.slice(2))}`
	return `cd ${shellSingleQuote(directory)}`
}

/**
 * Build the remote POSIX shell program that starts the far side's Harness.
 *
 * The `cat > /dev/null` is the teardown contract, and it is deliberate. A remote
 * command started over ssh does NOT reliably die when the connection goes away:
 * measured on this project, a plain `exec dsh web` and even one under `ssh -tt`
 * both survived the client being killed outright, leaving an orphaned server
 * holding the remote port. Blocking on stdin is deterministic instead — sshd
 * hands the remote command a pipe, and that pipe reaches EOF the moment the
 * connection ends however it ends, including a hard kill, so the backgrounded
 * server is always reaped.
 *
 * This is why the caller MUST give ssh a stdin that stays open (`'pipe'` and
 * never written to). With `'ignore'` the pipe is already at EOF and the server
 * would be killed the instant it started.
 *
 * `--port 0` is deliberate: the remote's OS picks a free port, so a connect can
 * never collide with a server the operator started by hand, with a stale
 * instance, or with another device entry aimed at the same host. The real port
 * is read back from the readiness line, and the tunnel is opened to it
 * afterwards — which is why a device needs two ssh connections rather than one.
 *
 * @param device - the device to start.
 * @returns one POSIX shell program string.
 */
function posixProgram(device) {
	const directory = typeof device.directory === 'string' && device.directory !== '' ? device.directory : undefined
	const enter = directory === undefined ? '' : `${remoteCd(directory)} || exit 1; `
	const server = 'dsh web --no-open --port 0'
	return `${resolvePreamble()}; ${enter}${server} & child=$!; cat > /dev/null; kill $child 2>/dev/null; wait $child 2>/dev/null; true`
}

/**
 * Quote one value as a PowerShell single-quoted literal.
 * @param value - the raw value.
 * @returns the literal, safe to embed in a script.
 */
function windowsLiteral(value) {
	return `'${String(value).replaceAll("'", "''")}'`
}

/**
 * The PowerShell prologue that locates the far side's `dsh`.
 *
 * There is no nvm and no `~/.local/bin` on Windows: a global npm install lands a
 * `.cmd` shim in `%APPDATA%\npm`, which is on PATH only if the installer put it
 * there. The explicit paths are the fallback for a PATH that was trimmed, which
 * is common for a non-interactive remote session.
 *
 * @returns the prologue statements.
 */
function windowsResolve() {
	return [
		'$dsh = $null',
		'$c = Get-Command dsh -CommandType Application -ErrorAction SilentlyContinue',
		'if ($null -ne $c) { $dsh = @($c)[0].Source }',
		'if ([string]::IsNullOrEmpty($dsh)) { foreach ($p in @("$env:APPDATA\\npm\\dsh.cmd", "$env:LOCALAPPDATA\\pnpm\\dsh.cmd", "$env:ProgramFiles\\nodejs\\dsh.cmd")) { if (Test-Path -LiteralPath $p) { $dsh = $p; break } } }',
		"if ([string]::IsNullOrEmpty($dsh)) { [Console]::Error.WriteLine('dsh is not on PATH on this Windows host'); exit 127 }"
	].join('; ')
}

/**
 * Build the remote PowerShell program that starts a Windows host's Harness.
 *
 * It reproduces the POSIX branch's contract rather than inventing a new one,
 * because the contract is what keeps a disconnected session from leaving an
 * orphaned server holding the remote port:
 *
 * - the server is a child process whose stdout is **inherited**, not redirected
 *   through a file, so the readiness line streams straight down the ssh channel
 *   with no temp file and no sharing problem;
 * - `[Console]::In.ReadToEnd()` blocks until stdin reaches EOF, which sshd
 *   delivers the moment the connection ends however it ends — the same
 *   deterministic teardown the POSIX branch gets from `cat > /dev/null`.
 *
 * The teardown kills the whole **tree**, not just the process it started, and
 * that is not belt-and-braces even though the launcher no longer starts the
 * `.cmd` shim: the process started here is the interpreter, and the Harness is
 * free to spawn under it. `Stop-Process` on a shim left `node` running —
 * measured on the local tab, which runs the same family of script — and the same
 * would happen on a Windows remote, where nothing would ever notice a server
 * still holding its port.
 *
 * **Two additions, both paid for by the Android client**, which is why this is
 * longer than the launcher it wraps:
 *
 * 1. **The interpreter and the script are resolved and logged.** Finding the shim
 *    is enough for `remoteDsh`'s one-shot `& $dsh --version`, but a server whose
 *    stdout has to survive being spawned with redirected pipes is a different
 *    proposition, and two launches that are equivalent at a prompt behave
 *    differently once PowerShell is started that way. So `node` and `bin.js` are
 *    located explicitly and named on stderr before anything starts.
 * 2. **A child that dies is noticed within a second.** Without the watchdog this
 *    program sits in `ReadToEnd()` for ever while the client waits for a readiness
 *    line that will never come, and the operator sees a connection that neither
 *    finishes nor fails. Measured on the Android side: `Start-Process` on a
 *    `dsh.cmd` that could not resolve its profile left no process behind and
 *    printed nothing at all.
 *
 * The watchdog's message prints an **empty exit code**, which reads like a bug in
 * the message: `Start-Process -PassThru` leaves `$proc.ExitCode` unset unless it is
 * also given `-Wait`, and `-Wait` would block and defeat the loop. Verified on
 * PowerShell 5.1 — `WaitForExit()` and `Refresh()` do not fill it in either. The
 * empty value is kept rather than papered over: "it exited and here is nothing" is
 * still the fact the operator needs, and naming a code that was never read would be
 * worse than leaving a blank.
 *
 * `~` is a POSIX habit, so it is translated here instead of being handed to
 * `Set-Location`, which would treat it as a relative path.
 *
 * @param device - the device to start.
 * @returns one PowerShell program string.
 */
function windowsProgram(device) {
	const directory = typeof device.directory === 'string' && device.directory !== '' ? device.directory : ''
	const parts = [
		// `windowsResolve` is shared with `remoteDsh`, whose contract is `& $dsh` — a
		// one-shot command through the shim, which works — so the interpreter is
		// resolved here rather than there. The two used to be one function; splitting
		// them is what let the launcher gain this without changing what a version
		// probe runs.
		windowsResolve(),
		"$node = 'FALLBACK'",
		'$shimDir = Split-Path -Parent $dsh',
		"$binJs = Join-Path $shimDir 'node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'",
		// A missing `bin.js` used to fall back to `$dsh` itself, and that cannot work
		// here: the launcher always starts `$node`, so no script would be named and
		// `node web --no-open --port 0` would exit on `Cannot find module …\web`,
		// blaming the wrong thing. Refused by name instead. Reachable wherever the
		// shim's own directory carries no `node_modules\@deepseek-ai\dsh` — a pnpm
		// global install, or a `dsh` shimmed in from somewhere else, among them.
		'if (-not (Test-Path -LiteralPath $binJs)) { [Console]::Error.WriteLine("dsh is at $dsh, but $binJs does not exist; this launcher starts node on bin.js rather than the .cmd shim, so bin.js has to sit in the node_modules beside the shim"); exit 127 }',
		// The shim's own directory first, because an npm global install may put
		// `node.exe` there; `%ProgramFiles%\nodejs` is the ordinary install, and the
		// bare name is the last resort. Each candidate is tested before it is chosen,
		// so the log below can say which one actually won.
		"$cand = @((Join-Path $shimDir 'node.exe'), (Join-Path $env:ProgramFiles 'nodejs\\node.exe'), 'node')",
		"foreach ($n in $cand) { if ($node -eq 'FALLBACK') { try { if (Get-Command $n -ErrorAction Stop) { $node = $n } } catch { } } }",
		...(directory === ''
			? []
			: [
					// **One statement, and it has to stay one.** The statements here are
					// joined with `'; '`, so writing the tilde translation as three parts
					// puts a semicolon between the closing brace and `elseif` — and
					// PowerShell then reads `elseif` as a *command name*:
					//
					//   elseif : The term 'elseif' is not recognized as the name of a
					//   cmdlet, function, script file, or operable program.
					//
					// Measured against a real Windows host, where it meant a device
					// configured `~/...` never had its `~` translated. The chain below is
					// still three statements; it is the *joins between them* that had to
					// change, so the `if`/`elseif` pair is never split across one.
					`$dir = ${windowsLiteral(directory)}; if ($dir -eq '~') { $dir = $env:USERPROFILE } elseif ($dir.StartsWith('~/') -or $dir.StartsWith('~\\')) { $dir = Join-Path $env:USERPROFILE $dir.Substring(2) }; $null = 0`,
					'Set-Location -LiteralPath $dir -ErrorAction Stop'
				]),
		// The script is named first and always: `$binJs` is the only thing this
		// launcher starts, and the check above guarantees it exists.
		'$argv = @($binJs)',
		"$argv += @('web','--no-open','--port','0')",
		// Written to stderr so it cannot be mistaken for the readiness line, which the
		// client reads from stdout. Naming the executable, the script and the working
		// directory is what turns "it failed" into an answer.
		'[Console]::Error.WriteLine("launch node=$node")',
		'[Console]::Error.WriteLine("launch script=$binJs exists=$(Test-Path -LiteralPath $binJs)")',
		'[Console]::Error.WriteLine("launch cwd=$((Get-Location).Path)")',
		'$proc = Start-Process -FilePath $node -ArgumentList $argv -NoNewWindow -PassThru',
		'$sw = [Diagnostics.Stopwatch]::StartNew()',
		'while ($sw.Elapsed.TotalSeconds -lt 60) { if ($proc.HasExited) { [Console]::Error.WriteLine("dsh exited with code $($proc.ExitCode) before announcing a URL"); break }; Start-Sleep -Milliseconds 500 }',
		'try { [Console]::In.ReadToEnd() | Out-Null } finally { if ($null -ne $proc -and -not $proc.HasExited) { taskkill /PID $proc.Id /T /F 2>&1 | Out-Null } }'
	]
	return parts.join('; ')
}

/**
 * Wrap one PowerShell script as a single ssh command argument.
 *
 * `-EncodedCommand` takes base64 UTF-16LE, which is the only quoting strategy
 * that survives the three layers between here and the script: ssh joins its
 * argv, the remote runs it through `cmd.exe`, and the script itself is full of
 * characters cmd would otherwise eat. The encoding contains no spaces or quotes,
 * so every layer passes it through untouched.
 *
 * @param script - the PowerShell script.
 * @returns the remote command argument.
 */
function windowsCommand(script) {
	return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
}

/**
 * Wrap one shell program as a single ssh command argument. ssh joins its
 * remaining argv with spaces, so passing exactly one element hands the remote
 * shell the program verbatim with no further quoting.
 *
 * `-i` is load-bearing, not cosmetic. bash sources `~/.bashrc` ONLY for
 * interactive shells, and that file is where people put the exports their tools
 * need. Launching the far side's Harness with a non-interactive shell silently
 * strips all of them: measured on a real device, `DEEPSEEK_API_KEY` was set in
 * `~/.bashrc`, empty under `bash -lc`, and the remote Harness therefore started
 * with no credential and asked the operator to type one in — for a machine that
 * already had it. PATH has the same failure mode. Asking for an interactive
 * login shell is the faithful emulation of "what the operator gets in a
 * terminal", which is the correct contract for starting their tool.
 *
 * The cost is bash's two job-control complaints on stderr when it is
 * interactive without a controlling terminal. They are harmless, they land in
 * the connect transcript, and they are the only visible difference.
 *
 * @param program - the shell program, interpreted per platform.
 * @param platform - which shell family the far side speaks.
 * @returns the remote command argument.
 */
function remoteCommand(program, platform = 'posix') {
	return platform === 'windows' ? windowsCommand(program) : `bash -lic ${shellSingleQuote(program)}`
}

/**
 * Pick the remote program for a host's shell family.
 * @param device - the device to start.
 * @param platform - which shell family the far side speaks.
 * @returns the remote command argument.
 */
function remoteProgram(device, platform = 'posix') {
	return platform === 'windows' ? windowsProgram(device) : posixProgram(device)
}

/**
 * A complete remote invocation of the far side's `dsh`, in the operator's own
 * shell environment.
 * @param args - arguments after `dsh`.
 * @param platform - which shell family the far side speaks.
 * @returns the remote command argument.
 */
function remoteDsh(args, platform = 'posix') {
	if (platform === 'windows') return windowsCommand(`${windowsResolve()}; & $dsh ${args}`)
	return remoteCommand(`${resolvePreamble()}; exec dsh ${args}`)
}

/**
 * The SSH option block shared by the tunnel and the probes. `BatchMode`
 * forbids an interactive password prompt: a GUI cannot answer one, so a
 * key-less device must fail loudly and immediately instead of hanging.
 * @param device - the device being reached.
 * @returns the option arguments.
 */
function sshOptions(device) {
	return [
		'-o', 'BatchMode=yes',
		'-o', 'StrictHostKeyChecking=accept-new',
		'-o', `ConnectTimeout=${String(Math.ceil(PROBE_TIMEOUT_MS / 1000))}`,
		'-p', String(Number(device.sshPort) || DEFAULT_SSH_PORT)
	]
}

/**
 * Decide a host's shell family from a `uname -s` probe.
 *
 * `uname -s` is one argv element with no metacharacters, so it survives every
 * shell: a POSIX host answers `Linux` or `Darwin` on stdout, while both cmd.exe
 * and PowerShell on Windows fail the command and put nothing on stdout.
 *
 * @param exitCode - the ssh process exit code.
 * @param stdout - the probe's stdout.
 * @returns the platform, or the connection error when ssh itself failed.
 */
function classifyPlatform(exitCode, stdout) {
	// 255 is ssh's own failure code. It means the connection failed, not that the
	// far side is Windows — an unreachable host has to fail once, with the ssh
	// error, instead of twice under a platform guess.
	if (exitCode === 255) return { error: true }
	return { platform: /^(linux|darwin|freebsd|openbsd|netbsd|sunos|aix)/imu.test(String(stdout).trim()) ? 'posix' : 'windows' }
}

/**
 * Split a readiness URL into the parts a tunnel needs.
 * @param url - the URL from the readiness line.
 * @returns the remote port and the session token.
 */
function parseReadyUrl(url) {
	const parsed = new URL(url)
	return { port: Number(parsed.port), token: parsed.searchParams.get('token') }
}

/**
 * Whether a launch directory can be embedded in a shell program at all.
 *
 * This validates a value that arrives from the device book and ends up inside
 * three different shells. Both **remote** branches escape it — `shellSingleQuote`
 * for POSIX, `windowsLiteral` inside the `-EncodedCommand` script for Windows —
 * but the **local Windows** branch cannot, because `cmd /c` takes one command
 * *string* and `cd /d` needs its path in double quotes. A path containing `"`
 * therefore closes the quote, and everything after it is a new command:
 *
 * ```
 * directory  ~/work" & calc.exe & "
 * cmd /c     cd /d "~/work" & calc.exe & "" && dsh web --no-open --port 0
 * ```
 *
 * Escaping that correctly is not worth attempting. `%VAR%` and delayed `!VAR!`
 * expand even *inside* double quotes, so a path that looks safely quoted can still
 * be rewritten before `cd` ever sees it, and cmd's rules differ between its
 * command line and a batch file. Every character rejected below is either
 * impossible or vanishingly unusual in a real Windows directory, so refusing them
 * costs an operator nothing and removes the class rather than one instance.
 *
 * POSIX is deliberately not restricted: a single-quoted POSIX string has no
 * metacharacters at all, so `~/work; rm -rf /` is just a directory name there.
 *
 * @param directory - the configured directory, or undefined when there is none.
 * @returns an error message, or null when the value is embeddable.
 */
function directoryProblem(directory) {
	if (directory === undefined || directory === '') return null
	const offenders = [...new Set([...String(directory)].filter((character) => '"\'%!&|<>^'.includes(character)))]
	if (offenders.length === 0) return null
	return `the launch directory contains ${offenders.map((character) => `\`${character}\``).join(', ')}, which cannot be passed to a shell safely`
}

/**
 * The argv that starts a Harness **on this machine**, for the local tab.
 *
 * On POSIX it reuses the remote branch's program, so the local tab gets the same
 * `stdin`-EOF teardown a remote tab has.
 *
 * **On Windows it does not, and that is a measured decision, not a shortcut.**
 * The obvious symmetry — wrap it in the same PowerShell program — is wrong:
 * `Start-Process -NoNewWindow` does not give the server a usable stdout when
 * PowerShell itself was spawned with pipes, which is how this application spawns
 * it. Measured three ways against the same `dsh`:
 *
 * | launch | result |
 * | --- | --- |
 * | `cmd /c "dsh web --no-open --port 0"` | readiness line in **1.5 s** |
 * | `powershell -Command "dsh web …"` | exit 1 |
 * | the `Start-Process` wrapper | **no output at all for 30 s** |
 *
 * So the Windows local tab has no stdin contract. What reaps it is the tree kill
 * in `connect.js`, which is what actually works: `dsh` resolves to a `.cmd` shim,
 * so the process started here is `cmd.exe` and the Harness is its `node` child.
 *
 * Because it is a single command string handed to `cmd`, this is the one branch
 * that cannot escape its directory — so it refuses the ones it cannot place, via
 * `directoryProblem`, instead of building a line that means something else.
 * Callers check that first and report it; a `throw` here is the backstop for a
 * caller that forgot.
 *
 * @param platform - the local platform.
 * @param directory - an optional working directory for the Harness.
 * @returns the argv to launch.
 */
function localDshArgv(platform = process.platform, directory) {
	const pseudo = directory === undefined || directory === '' ? {} : { directory }
	if (platform === 'win32') {
		const enter = typeof pseudo.directory === 'string' && pseudo.directory !== '' ? `cd /d "${pseudo.directory}" && ` : ''
		if (enter !== '') {
			const problem = directoryProblem(pseudo.directory)
			if (problem !== null) throw new Error(problem)
		}
		return [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), '/c', `${enter}dsh web --no-open --port 0`]
	}
	return ['bash', '-lic', posixProgram(pseudo)]
}

module.exports = {
	READY_LINE,
	START_TIMEOUT_MS,
	PROBE_TIMEOUT_MS,
	TUNNEL_TIMEOUT_MS,
	DEFAULT_SSH_PORT,
	readyUrl,
	shellSingleQuote,
	resolvePreamble,
	remoteCd,
	posixProgram,
	windowsLiteral,
	windowsResolve,
	windowsProgram,
	windowsCommand,
	remoteCommand,
	remoteProgram,
	remoteDsh,
	sshOptions,
	classifyPlatform,
	parseReadyUrl,
	directoryProblem,
	localDshArgv
}
