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
 * **Three additions, all paid for with a real failure**, which is why this is
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
 * 3. **A previous launch is reaped before this one starts.** The stdin contract
 *    above only fires when the connection ends; a client that goes away without
 *    ending it leaves a Harness that outlives every later connection and keeps the
 *    Sessions' write leases, which the next window cannot open
 *    (`session/writer-held`). Measured on a real Windows remote on 2026-11-25: four
 *    minutes of exactly that, after the same tablet had already reconnected. A
 *    launch now records what it started and the next launch kills that record, so
 *    the leak is repaired by the next connect instead of by hand.
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
		// **`Get-Command` is not enough, and the way it fails is worse than not at all.**
		// It answers with whatever PATH finds first, and a package manager's shim can sit
		// in front of an npm install while carrying no `bin.js` of its own — measured on
		// this machine with such a shim first on PATH: the old code chose it and refused
		// with exit 127 *while a launchable dsh sat behind it*, sending the operator to
		// reinstall something that was already installed. The walk below takes the first
		// candidate whose own directory carries the script, and the well-known locations
		// are the same fallback `windowsResolve` keeps for a PATH that was trimmed.
		"$candidates = @($dsh) + @(\"$env:APPDATA\\npm\\dsh.cmd\", \"$env:PNPM_HOME\\dsh.cmd\", \"$env:LOCALAPPDATA\\pnpm\\bin\\dsh.cmd\", \"$env:ProgramFiles\\nodejs\\dsh.cmd\")",
		'$binJs = $null; $shimDir = $null; $dsh = $null',
		"foreach ($candidate in $candidates) { if ([string]::IsNullOrEmpty($candidate)) { continue }; $dir = Split-Path -Parent $candidate; $bin = Join-Path $dir 'node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'; if (Test-Path -LiteralPath $bin) { $dsh = $candidate; $shimDir = $dir; $binJs = $bin; break } }",
		// A missing `bin.js` used to fall back to `$dsh` itself, and that cannot work
		// here: the launcher always starts `$node`, so no script would be named and
		// `node web --no-open --port 0` would exit on `Cannot find module …\web`,
		// blaming the wrong thing. Refused by name instead, and the message counts the
		// candidates rather than listing them — the client truncates a remote reason at
		// 300 characters, and four paths are most of that on their own.
		'if ([string]::IsNullOrEmpty($binJs)) { [Console]::Error.WriteLine("no launchable dsh on this Windows host: $($candidates.Count) candidate(s) checked, none carries node_modules\\@deepseek-ai\\dsh\\lib\\bin.js - install dsh with npm -g, or point PATH at a shim whose directory has one"); exit 127 }',
		// The shim's own directory first, because an npm global install may put
		// `node.exe` there; `%ProgramFiles%\nodejs` is the ordinary install, and the
		// bare name is the last resort. Each candidate is tested before it is chosen,
		// so the log below can say which one actually won.
		"$cand = @((Join-Path $shimDir 'node.exe'), (Join-Path $env:ProgramFiles 'nodejs\\node.exe'), 'node')",
		"foreach ($n in $cand) { if ($node -eq 'FALLBACK') { try { if (Get-Command $n -ErrorAction Stop) { $node = $n } } catch { } } }",
		// The other half of the same silence: `$node` staying at its sentinel means the
		// launcher is about to run `FALLBACK <script>`, which is a command-not-found
		// dressed up as a launch. Said out loud, with where it looked.
		"if ($node -eq 'FALLBACK') { [Console]::Error.WriteLine(\"no node.exe on this Windows host: looked in $shimDir, $env:ProgramFiles\\nodejs and on PATH\"); exit 127 }",
		// **A launch that outlives its client is only visible at the next launch, so the
		// next launch is what has to repair it.**
		//
		// The stdin contract below is deterministic in the ordinary case (probed on this
		// machine: EOF arrives, the tree is killed, the supervisor exits), but it only
		// fires when the *connection* ends. Measured on a real Windows remote on
		// 2026-11-25: a Harness started by the tablet's earlier connection was still
		// serving and still held its Sessions' write leases four minutes after the
		// operator had reconnected from the same device, and DSH gives a Session one
		// writer, so every attempt to open those Sessions in the new window failed with
		// `session/writer-held` — the UI's "当前会话已被占用，可能是其他正在运行的 DSH
		// 导致的…". Two Harnesses over one DSH home can never share those leases, so the
		// only useful states are "one" and "none".
		//
		// So the launch records what it started and the next launch reaps that record
		// before starting anything: the leak becomes a self-healing state at the next
		// connect instead of a machine somebody has to fix by hand. The record holds the
		// **supervisor's** pid as well as the Harness's, because the supervisor is the
		// ancestor that `taskkill /T` can walk, and a supervisor whose connection never
		// ended is otherwise left waiting on stdin for ever — today's leak was two of
		// them.
		//
		// A pid on its own is not evidence: each one is killed only while it still
		// carries the identity this launcher gave it (a `powershell.exe` running
		// `-EncodedCommand`, or a `node.exe` running this exact argv), so a recycled pid
		// can never take an unrelated process — or an operator's own `dsh web` — with it.
		'$mroot = $env:LOCALAPPDATA; if ([string]::IsNullOrEmpty($mroot)) { $mroot = $env:TEMP }',
		"$marker = Join-Path $mroot 'dsh-tabs\\remote-harness.json'",
		'if (Test-Path -LiteralPath $marker) { $old = $null; try { $old = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json } catch { }; if ($null -ne $old) { $hp = $null; $sp = $null; if ($null -ne $old.pid) { try { $hp = Get-CimInstance Win32_Process -Filter "ProcessId=$($old.pid)" } catch { } }; if ($null -ne $old.sup) { try { $sp = Get-CimInstance Win32_Process -Filter "ProcessId=$($old.sup)" } catch { } }; if ($null -ne $hp -and $hp.Name -eq \'node.exe\' -and $hp.CommandLine -and $hp.CommandLine.Contains(\' web --no-open --port 0\')) { taskkill /PID $hp.ProcessId /T /F 2>&1 | Out-Null; [Console]::Error.WriteLine("launch reaped harness=$($hp.ProcessId)") }; if ($null -ne $sp -and $sp.Name -eq \'powershell.exe\' -and $sp.CommandLine -and $sp.CommandLine.Contains(\'-EncodedCommand\')) { taskkill /PID $sp.ProcessId /T /F 2>&1 | Out-Null; [Console]::Error.WriteLine("launch reaped supervisor=$($sp.ProcessId)") } }; Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue }',
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
		// The record is written as soon as the process exists and before anything else
		// can fail, because it is what makes the launch findable if the teardown below
		// never runs. A failure to write it is swallowed: refusing a launch over its
		// bookkeeping would leak exactly the Harness the bookkeeping exists to catch.
		'try { New-Item -ItemType Directory -Path (Split-Path -Parent $marker) -Force | Out-Null; @{ sup = $PID; pid = $proc.Id; started = (Get-Date).ToString(\'o\'); node = $node; binJs = $binJs; cwd = (Get-Location).Path } | ConvertTo-Json -Compress | Set-Content -LiteralPath $marker -Encoding UTF8 } catch { }',
		'$sw = [Diagnostics.Stopwatch]::StartNew()',
		'while ($sw.Elapsed.TotalSeconds -lt 60) { if ($proc.HasExited) { [Console]::Error.WriteLine("dsh exited with code $($proc.ExitCode) before announcing a URL"); break }; Start-Sleep -Milliseconds 500 }',
		'try { [Console]::In.ReadToEnd() | Out-Null } finally { if ($null -ne $proc -and -not $proc.HasExited) { taskkill /PID $proc.Id /T /F 2>&1 | Out-Null }; $mine = $null; try { $mine = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json } catch { }; if ($null -ne $mine -and $mine.sup -eq $PID) { Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue } }'
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
 * The same block for a device whose account has a password and no usable key.
 *
 * Four differences, and each one is load-bearing:
 *
 * - **`BatchMode=no`.** `BatchMode=yes` is what forbids the prompt a GUI cannot
 *   answer; it also tells ssh never to consult `SSH_ASKPASS`, so keeping it would
 *   make the password path impossible rather than merely quiet.
 * - **`PreferredAuthentications=password,keyboard-interactive`.** The second name
 *   is not optional in the real world: a Debian or Ubuntu host with
 *   `KbdInteractiveAuthentication yes` offers only `keyboard-interactive`, and a
 *   client that lists only `password` is refused while the password is perfectly
 *   good. OpenSSH answers both through the same askpass program.
 * - **`PubkeyAuthentication=no`.** The requirement this branch exists for is "a
 *   password, not a key". Offering a key first would spend an authentication
 *   attempt on a credential the device was configured not to use, and would leave
 *   a host that rejects keys looking like a wrong password.
 * - **`NumberOfPasswordPrompts=1`.** The helper answers every prompt with the same
 *   string, so a second and third attempt are the same wrong password again — and
 *   on a host with a lockout policy they are three failures instead of one.
 *
 * `StrictHostKeyChecking=accept-new` and the port are copied from the key block
 * on purpose: the host-key policy is a property of the application, not of how
 * the account authenticates. `tools/smoke.mjs` asserts both blocks carry it.
 *
 * @param device - the device being reached.
 * @returns the option arguments.
 */
function sshPasswordOptions(device) {
	return [
		'-o', 'BatchMode=no',
		'-o', 'StrictHostKeyChecking=accept-new',
		'-o', `ConnectTimeout=${String(Math.ceil(PROBE_TIMEOUT_MS / 1000))}`,
		'-o', 'PreferredAuthentications=password,keyboard-interactive',
		'-o', 'PubkeyAuthentication=no',
		'-o', 'NumberOfPasswordPrompts=1',
		'-p', String(Number(device.sshPort) || DEFAULT_SSH_PORT)
	]
}

/**
 * Pick the option block a device's record asks for.
 *
 * `auth` is absent on every book written before this existed, so the key block
 * stays the default and an old book keeps its exact behaviour. The choice is a
 * property of the record rather than of a connect so that a reconnect and a
 * terminal use the same one without being told.
 *
 * @param device - the device being reached.
 * @returns the option arguments.
 */
function sshOptionsFor(device) {
	return device.auth === 'password' ? sshPasswordOptions(device) : sshOptions(device)
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

/**
 * The persistent-host protocol: what a far side runs so that its Harness
 * outlives the ssh connection, and how a later connection finds it again.
 *
 * **The problem it solves.** Everything above tears a Harness down with the
 * connection, on purpose: the stdin contract is what stops an orphan holding the
 * remote port. That is the right ownership when the operator is watching a tab,
 * and the wrong one when the operator wants a Session to keep working after the
 * laptop sleeps. A persistent host is the same `dsh web --no-open --port 0`, but
 * started so that no part of the ssh session owns it, and recorded so the next
 * connection can adopt it instead of starting a second one.
 *
 * **Two processes over one DSH home cannot share Session write leases**, so the
 * useful states are "one" and "none" (see `teardown.staleLaunch` in
 * `docs/contract.json`). Adoption is therefore not a convenience: it is what
 * keeps two clients from producing the `session/writer-held` that a leaked
 * launch produced on 2026-11-25.
 *
 * **What each side is responsible for.**
 * - The *ensure* program: adopt a live host recorded in this home, or start one
 *   detached and wait for its readiness line. It prints `HOST adopted …` or
 *   `HOST started …` and then the readiness line itself, so a client parses the
 *   same line it always has.
 * - The *stop* program: kill the recorded host and remove the record. Only ever
 *   run on an explicit operator action.
 * - The *client*: parse those two lines, then open the tunnel exactly as before.
 *
 * **Why `nohup` and not `setsid` on POSIX.** `setsid` is the textbook detach, but
 * it forks when its caller is a process-group leader, so the pid it leaves behind
 * is not reliably the Harness's. `nohup … &` execs the target, so `$!` is the
 * real pid — and nohup already covers the SIGHUP. This project has also measured
 * that a POSIX child survives the client being killed (`posixProgram`'s comment),
 * so the signal was never the load-bearing part.
 *
 * **Why WMI on Windows.** A `Start-Process` inside the ssh session is a child of
 * sshd's PowerShell; whether the session teardown reaches it was never measured.
 * `Win32_Process.Create` gives the process a parent of `WmiPrvSE.exe` instead, so
 * there is nothing for the session to reach. Measured on 2026-11-26: the created
 * `dsh web` served normally after its creator exited.
 */

/** The directory, inside the far side's DSH home, that holds the host record. */
const HOST_DIR = 'dsh-tabs'

/** The record one persistent host leaves for the next connection. */
const HOST_RECORD_FILE = 'host.json'

/** The log the detached Harness writes; the readiness line is read from it. */
const HOST_LOG_FILE = 'host.log'

/** The generated launcher a Windows host is started through. */
const HOST_LAUNCHER_FILE = 'start-host.cmd'

/** Serialisation version of the record, so a client can refuse a future one. */
const HOST_RECORD_VERSION = 1

/**
 * How long a detached Harness may take to announce its URL.
 *
 * Longer than `START_TIMEOUT_MS` on purpose: a first start on a cold machine
 * writes a profile and a session directory, and the client is no longer
 * streaming the server's stdout — it is polling a log file, so the cost of a
 * generous budget is a slower failure, not a stuck pipe.
 */
const HOST_START_TIMEOUT_MS = 60_000

/**
 * How long one connection may wait for another connection's ensure to finish.
 * Two clients starting the same device at once is rare; two Harnesses over one
 * home is the failure this lock exists to prevent.
 */
const HOST_LOCK_WAIT_MS = 30_000

/** How many 300 ms tries one connection makes for another connection's lock. */
const HOST_LOCK_TRIES = Math.ceil(HOST_LOCK_WAIT_MS / 300)

/** How many 500 ms reads of the log a first start makes before giving up. */
const HOST_START_TRIES = Math.ceil(HOST_START_TIMEOUT_MS / 500)

/**
 * The DSH home a persistent host belongs to, as a POSIX shell expression.
 *
 * `DSH_HOME` is the only knob DSH itself documents for this, so a device may
 * point at a second home on the same machine — which is also what makes a test
 * run able to leave the operator's live home alone.
 * @returns one shell assignment statement.
 */
function hostHomePosix() {
	return 'home="${DSH_HOME:-$HOME/.dsh}"'
}

/**
 * The five fields the ensure program reads back out of the record.
 *
 * The values are numeric, base64url, and an ISO timestamp, so the `sed` below
 * never has to handle a quote or a comma. Paths are deliberately not in the
 * record: the record lives inside the home it describes, which is a stronger
 * statement of the same fact and one fewer thing to escape.
 * @param recordVar - the shell variable holding the record path.
 * @returns the shell statements that assign `pid`, `port`, `token`, `started`.
 */
function readRecordPosix(recordVar) {
	const field = (name, pattern) => `${name}=$(sed -n 's/.*"${name}":${pattern}.*/\\1/p' "$${recordVar}" 2>/dev/null | head -n 1)`
	return [
		field('pid', '\\([0-9][0-9]*\\)'),
		field('port', '\\([0-9][0-9]*\\)'),
		field('token', '"\\([A-Za-z0-9_-]*\\)"'),
		field('started', '"\\([^"]*\\)"')
	]
}

/**
 * The POSIX program that adopts or starts the persistent host.
 *
 * A device may name a DSH home (`device.home`); it is exported before anything
 * else so that the record, the log, and the Harness itself all live in the same
 * one. That is also what lets a test run against a second home on a machine whose
 * default home is serving somebody's live Session.
 *
 * @param device - the device whose home is being served.
 * @returns one shell program.
 */
function posixPersistentEnsure(device) {
	const directory = typeof device.directory === 'string' && device.directory !== '' ? device.directory : undefined
	const enter = directory === undefined ? '' : `${remoteCd(directory)} || exit 1; `
	const home = typeof device.home === 'string' && device.home !== '' ? `export DSH_HOME=${shellSingleQuote(device.home)}; ` : ''
	const statements = [
		resolvePreamble(),
		hostHomePosix(),
		'hd="$home/dsh-tabs"',
		'mkdir -p "$hd" || exit 1',
		'rec="$hd/host.json"',
		'log="$hd/host.log"',
		'lock="$hd/ensure.lock"',
		// One ensure at a time. Two connections that both see "no host" would
		// otherwise both start one, and two Harnesses over one home is exactly the
		// state that makes a Session unopenable. A lock left by a killed client is
		// broken only after 120 s, which is longer than any healthy ensure.
		`i=0
while ! mkdir "$lock" 2>/dev/null; do
	sleep 0.3
	i=$((i+1))
	if [ "$i" -gt ${String(HOST_LOCK_TRIES)} ]; then
		if [ -d "$lock" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +2 2>/dev/null)" ]; then rm -rf "$lock"; continue; fi
		echo "HOST error another connection is starting this host and did not finish"
		exit 1
	fi
done
trap 'rmdir "$lock" 2>/dev/null' EXIT`,
		...readRecordPosix('rec'),
		// Adopt. The identity is three facts, not one: a pid is recycled, a port can
		// be taken by something else, and `ps` says whether the pid is still a
		// Harness. The readiness URL is rebuilt from the record, so adoption needs
		// no log at all.
		`if [ -n "$pid" ] && [ -n "$port" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= 2>/dev/null | grep -q " web " && (exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
	echo "HOST adopted pid=$pid port=$port token=$token started=$started"
	echo "dsh web: http://127.0.0.1:$port/?token=$token"
	exit 0
fi`,
		'rm -f "$rec"',
		': > "$log"',
		// `nohup` execs the target, so `$!` is the Harness's own pid; `</dev/null`
		// keeps it off the ssh session's stdin, and nohup makes SIGHUP irrelevant.
		'nohup dsh web --no-open --port 0 >>"$log" 2>&1 </dev/null & pid=$!',
		`line=""
for i in {1..${String(HOST_START_TRIES)}}; do
	line=$(sed -n "s/^dsh web: //p" "$log" | tail -n 1)
	[ -n "$line" ] && break
	kill -0 "$pid" 2>/dev/null || break
	sleep 0.5
done`,
		`if [ -z "$line" ]; then
	echo "HOST error the Harness did not announce a URL within 60s"
	sed -n "1,20p" "$log"
	exit 1
fi`,
		`port=$(printf '%s' "$line" | sed -n 's#.*://[^/]*:\\([0-9][0-9]*\\)/.*#\\1#p')
token=$(printf '%s' "$line" | sed -n 's#.*[?&]token=\\([A-Za-z0-9_-]*\\).*#\\1#p')
if [ -z "$port" ] || [ -z "$token" ]; then
	echo "HOST error the readiness line carried no port or token"
	exit 1
fi`,
		'started=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
		`printf '{"version":${String(HOST_RECORD_VERSION)},"pid":%s,"port":%s,"token":"%s","started":"%s"}\\n' "$pid" "$port" "$token" "$started" > "$rec.tmp" && mv "$rec.tmp" "$rec" && chmod 600 "$rec" 2>/dev/null`,
		'echo "HOST started pid=$pid port=$port token=$token started=$started"',
		'echo "dsh web: $line"'
	]
	return `${resolvePreamble()}; ${home}${enter}${statements.slice(1).join('; ')}`
}

/**
 * The POSIX program that stops the recorded host.
 *
 * Only ever run from an explicit operator action: a persistent host is somebody's
 * running work, and nothing in this application kills one on its own.
 * @param device - the device whose host is being stopped, for its home.
 * @returns one shell program.
 */
function posixPersistentStop(device = {}) {
	const home = typeof device.home === 'string' && device.home !== '' ? `export DSH_HOME=${shellSingleQuote(device.home)}; ` : ''
	return `${home}${[
		hostHomePosix(),
		'hd="$home/dsh-tabs"',
		'rec="$hd/host.json"',
		'if [ ! -f "$rec" ]; then echo "HOST none"; exit 0; fi',
		...readRecordPosix('rec'),
		`if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= 2>/dev/null | grep -q " web "; then
	kill "$pid" 2>/dev/null
	sleep 1
	kill -9 "$pid" 2>/dev/null
	echo "HOST stopped pid=$pid"
else
	echo "HOST stale pid is gone or is not a Harness"
fi`,
		'rm -f "$rec"'
	].join('; ')}`
}

/**
 * The PowerShell that locates `node` and `bin.js`, for the persistent branch.
 *
 * This repeats the walk inside `windowsProgram` instead of sharing it. That
 * program's bytes are pinned — by the contract, by the Android parity test, and
 * by `tools/smoke.mjs` — so lifting a block out of it would change a string that
 * three other things compare, to save one copy here. The copy is the cheaper of
 * the two costs, and this comment is why the next reader does not merge them.
 * @returns the statements, one per line.
 */
function windowsHostResolve() {
	return String.raw`$dsh = $null
$c = Get-Command dsh -CommandType Application -ErrorAction SilentlyContinue
if ($null -ne $c) { $dsh = @($c)[0].Source }
if ([string]::IsNullOrEmpty($dsh)) { foreach ($p in @("$env:APPDATA\npm\dsh.cmd", "$env:PNPM_HOME\dsh.cmd", "$env:LOCALAPPDATA\pnpm\bin\dsh.cmd", "$env:ProgramFiles\nodejs\dsh.cmd")) { if (Test-Path -LiteralPath $p) { $dsh = $p; break } } }
$candidates = @($dsh) + @("$env:APPDATA\npm\dsh.cmd", "$env:PNPM_HOME\dsh.cmd", "$env:LOCALAPPDATA\pnpm\bin\dsh.cmd", "$env:ProgramFiles\nodejs\dsh.cmd")
$binJs = $null; $shimDir = $null; $dsh = $null
foreach ($candidate in $candidates) { if ([string]::IsNullOrEmpty($candidate)) { continue }; $dir = Split-Path -Parent $candidate; $bin = Join-Path $dir 'node_modules\@deepseek-ai\dsh\lib\bin.js'; if (Test-Path -LiteralPath $bin) { $dsh = $candidate; $shimDir = $dir; $binJs = $bin; break } }
if ([string]::IsNullOrEmpty($binJs)) { Write-Output 'HOST error no launchable dsh on this Windows host'; exit 1 }
$node = $null
$cand = @((Join-Path $shimDir 'node.exe'), (Join-Path $env:ProgramFiles 'nodejs\node.exe'), 'node')
foreach ($n in $cand) { if ($null -eq $node) { try { if (Get-Command $n -ErrorAction Stop) { $node = $n } } catch { } } }
if ($null -eq $node) { Write-Output 'HOST error no node.exe on this Windows host'; exit 1 }`
}

/**
 * The Windows program that adopts or starts the persistent host.
 *
 * The Harness is started through a generated `.cmd` and created by WMI. Both
 * halves are measured decisions (2026-11-26):
 * - a `.cmd` file, because the nested quoting of `cmd /c ""set "X=…" && …""` is
 *   parsed wrong and reports `'"set "PROBE_INLINE' is not recognized`;
 * - WMI, because `Win32_Process.Create` gives the process a `WmiPrvSE.exe`
 *   parent, so no part of the ssh session owns it.
 * @param device - the device whose home is being served.
 * @returns one PowerShell program.
 */
function windowsPersistentEnsure(device) {
	const directory = typeof device.directory === 'string' && device.directory !== '' ? device.directory : ''
	const enter = directory === ''
		? ''
		: [
				`$dir = ${windowsLiteral(directory)}; if ($dir -eq '~') { $dir = $env:USERPROFILE } elseif ($dir.StartsWith('~/') -or $dir.StartsWith('~\\')) { $dir = Join-Path $env:USERPROFILE $dir.Substring(2) }; $null = 0`,
				'Set-Location -LiteralPath $dir -ErrorAction Stop'
			].join('; ')
	return String.raw`$ErrorActionPreference = 'Stop'
${typeof device.home === 'string' && device.home !== '' ? `$env:DSH_HOME = ${windowsLiteral(device.home)}\n` : ''}${windowsHostResolve()}
${enter === '' ? '' : enter + '\n'}$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$hd = Join-Path $dshHome 'dsh-tabs'
New-Item -ItemType Directory -Force -Path $hd | Out-Null
$rec = Join-Path $hd 'host.json'
$log = Join-Path $hd 'host.log'
$lock = Join-Path $hd 'ensure.lock'
$locked = $false
$sw = [Diagnostics.Stopwatch]::StartNew()
while (-not $locked) {
  try { New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null; $locked = $true; break } catch { }
  if ((Test-Path -LiteralPath $lock) -and ((Get-Date) - (Get-Item -LiteralPath $lock).LastWriteTime).TotalSeconds -gt 120) { Remove-Item -LiteralPath $lock -Recurse -Force -ErrorAction SilentlyContinue; continue }
  if ($sw.Elapsed.TotalMilliseconds -gt ${String(HOST_LOCK_WAIT_MS)}) { break }
  Start-Sleep -Milliseconds 300
}
if (-not $locked) { Write-Output 'HOST error another connection is starting this host and did not finish'; exit 1 }
try {
  $record = $null
  if (Test-Path -LiteralPath $rec) { try { $record = Get-Content -LiteralPath $rec -Raw | ConvertFrom-Json } catch { $record = $null } }
  if ($null -ne $record -and $null -ne $record.pid -and $null -ne $record.port) {
    $live = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$record.pid) -ErrorAction SilentlyContinue
    $listening = $false
    if ($null -ne $live) {
      $tcp = $null
      try { $tcp = [Net.Sockets.TcpClient]::new(); $listening = $tcp.ConnectAsync('127.0.0.1', [int]$record.port).Wait(2000) } catch { $listening = $false } finally { if ($null -ne $tcp) { $tcp.Dispose() } }
    }
    if ($null -ne $live -and $live.Name -eq 'node.exe' -and -not [string]::IsNullOrEmpty($live.CommandLine) -and $live.CommandLine.Contains(' web ') -and $listening) {
      Write-Output ('HOST adopted pid=' + $record.pid + ' port=' + $record.port + ' token=' + $record.token + ' started=' + $record.started)
      Write-Output ('dsh web: http://127.0.0.1:' + $record.port + '/?token=' + $record.token)
      exit 0
    }
  }
  Remove-Item -LiteralPath $rec -Force -ErrorAction SilentlyContinue
  Set-Content -LiteralPath $log -Value '' -Encoding ASCII
  $launcher = Join-Path $hd '${HOST_LAUNCHER_FILE}'
  $lines = @('@echo off', ('set "DSH_HOME=' + $dshHome + '"'), ('"' + $node + '" "' + $binJs + '" web --no-open --port 0 > "' + $log + '" 2>&1'))
  Set-Content -LiteralPath $launcher -Value $lines -Encoding ASCII
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('cmd.exe /c "' + $launcher + '"'); CurrentDirectory = (Get-Location).Path }
  if ($created.ReturnValue -ne 0) { Write-Output ('HOST error WMI create failed rc=' + $created.ReturnValue); exit 1 }
  $line = $null
  $wait = [Diagnostics.Stopwatch]::StartNew()
  while ($wait.Elapsed.TotalMilliseconds -lt ${String(HOST_START_TIMEOUT_MS)}) {
    if (Test-Path -LiteralPath $log) { $found = Select-String -LiteralPath $log -Pattern '^dsh web: (\S+)$' | Select-Object -Last 1; if ($null -ne $found) { $line = $found.Matches[0].Groups[1].Value; break } }
    if ($null -eq (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $created.ProcessId) -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 400
  }
  if ($null -eq $line) { Write-Output 'HOST error the Harness did not announce a URL within 60s'; if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -TotalCount 20 }; exit 1 }
  $nodePid = $null
  for ($i = 0; $i -lt 20 -and $null -eq $nodePid; $i++) { $child = Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $created.ProcessId) -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'node.exe' } | Select-Object -First 1; if ($null -ne $child) { $nodePid = $child.ProcessId } else { Start-Sleep -Milliseconds 200 } }
  if ($null -eq $nodePid) { Write-Output 'HOST error the launcher produced no node process'; exit 1 }
  $port = [regex]::Match($line, ':([0-9]+)/').Groups[1].Value
  $token = [regex]::Match($line, '[?&]token=([A-Za-z0-9_-]+)').Groups[1].Value
  if (-not $port -or -not $token) { Write-Output 'HOST error the readiness line carried no port or token'; exit 1 }
  $started = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $json = '{"version":${String(HOST_RECORD_VERSION)},"pid":' + $nodePid + ',"port":' + $port + ',"token":"' + $token + '","started":"' + $started + '"}'
  Set-Content -LiteralPath $rec -Value $json -Encoding ASCII
  Write-Output ('HOST started pid=' + $nodePid + ' port=' + $port + ' token=' + $token + ' started=' + $started)
  Write-Output ('dsh web: ' + $line)
} finally {
  Remove-Item -LiteralPath $lock -Recurse -Force -ErrorAction SilentlyContinue
}`
}

/**
 * The Windows program that stops the recorded host.
 * @param device - the device whose host is being stopped, for its home.
 * @returns one PowerShell program.
 */
function windowsPersistentStop(device = {}) {
	return String.raw`${typeof device.home === 'string' && device.home !== '' ? `$env:DSH_HOME = ${windowsLiteral(device.home)}\n` : ''}$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$rec = Join-Path (Join-Path $dshHome 'dsh-tabs') 'host.json'
if (-not (Test-Path -LiteralPath $rec)) { Write-Output 'HOST none'; exit 0 }
$record = $null
try { $record = Get-Content -LiteralPath $rec -Raw | ConvertFrom-Json } catch { $record = $null }
if ($null -eq $record -or $null -eq $record.pid) { Remove-Item -LiteralPath $rec -Force -ErrorAction SilentlyContinue; Write-Output 'HOST stale the record names no pid'; exit 0 }
$live = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$record.pid) -ErrorAction SilentlyContinue
if ($null -eq $live -or $live.Name -ne 'node.exe' -or [string]::IsNullOrEmpty($live.CommandLine) -or -not $live.CommandLine.Contains(' web ')) { Remove-Item -LiteralPath $rec -Force -ErrorAction SilentlyContinue; Write-Output 'HOST stale pid is gone or is not a Harness'; exit 0 }
& taskkill /PID ([int]$record.pid) /T /F 2>&1 | Out-Null
Start-Sleep -Milliseconds 500
Remove-Item -LiteralPath $rec -Force -ErrorAction SilentlyContinue
Write-Output ('HOST stopped pid=' + $record.pid)`
}

/**
 * Pick the adopt-or-start program for a shell family.
 * @param device - the device whose home is being served.
 * @param platform - which shell family the far side speaks.
 * @returns the remote command argument.
 */
function persistentEnsureProgram(device, platform = 'posix') {
	return platform === 'windows' ? windowsPersistentEnsure(device) : posixPersistentEnsure(device)
}

/**
 * Pick the stop program for a shell family.
 * @param device - the device whose host is being stopped, for its home.
 * @param platform - which shell family the far side speaks.
 * @returns the remote command argument.
 */
function persistentStopProgram(device = {}, platform = 'posix') {
	return platform === 'windows' ? windowsPersistentStop(device) : posixPersistentStop(device)
}

module.exports = {
	READY_LINE,
	START_TIMEOUT_MS,
	PROBE_TIMEOUT_MS,
	TUNNEL_TIMEOUT_MS,
	DEFAULT_SSH_PORT,
	HOST_DIR,
	HOST_RECORD_FILE,
	HOST_LOG_FILE,
	HOST_LAUNCHER_FILE,
	HOST_RECORD_VERSION,
	HOST_START_TIMEOUT_MS,
	HOST_LOCK_WAIT_MS,
	persistentEnsureProgram,
	persistentStopProgram,
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
	sshPasswordOptions,
	sshOptionsFor,
	classifyPlatform,
	parseReadyUrl,
	directoryProblem,
	localDshArgv
}
