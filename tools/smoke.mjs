/**
 * Offline checks for dsh-tabs.
 *
 * This suite deliberately does not start Electron. What it can pin down is the
 * part that has burned this project before: the exact bytes handed to a remote
 * shell, the platform classification, and — most importantly — that the logic
 * copied out of the `dsh-remote-devices` plugin still agrees with the original.
 * A standalone app cannot import from a plugin directory the operator may
 * delete, so the two copies exist; drift between them has to fail loudly here
 * rather than surface later as a mysterious connect failure.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

/**
 * Where to find the plugin this application's remote logic was copied from.
 *
 * It cannot be a fixed relative path. This app has to live **outside**
 * `$DSH_HOME` — Electron will not start from inside it, see the README — and the
 * plugin has to live **inside** it, so the two are never siblings in a working
 * install. `DSH_REMOTE_DEVICES_PLUGIN` names the file explicitly; otherwise a few
 * plausible locations are tried.
 *
 * @returns the path, or undefined when the reference is not on this machine.
 */
function findPlugin() {
	const explicit = process.env.DSH_REMOTE_DEVICES_PLUGIN
	if (explicit !== undefined && existsSync(explicit)) return explicit
	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
	const candidates = [
		join(ROOT, '..', '..', 'plugins', 'dsh-remote-devices', 'index.js'),
		join(home, 'plugins', 'dsh-remote-devices', 'index.js'),
		join(home, 'apps', 'dsh-tabs', '..', '..', 'plugins', 'dsh-remote-devices', 'index.js')
	]
	return candidates.find((candidate) => existsSync(candidate))
}

const PLUGIN = findPlugin()

/**
 * Keep this suite away from the operator's real device book.
 *
 * One of the checks below writes the book — it exercises `mutate`, which is the
 * serialized read-modify-write, so it has to run against a real file. Left alone,
 * `src/devices.js` points at `$DSH_HOME/dsh-tabs.json`, and running this file
 * directly in a shell that exports `DSH_HOME` would do it to the real devices. So
 * a scratch home is installed **before `devices.js` is first required**, because
 * that module resolves its paths at require time and nothing can change them
 * afterwards.
 *
 * An explicit `DSH_TABS_TEST_HOME` is honoured, and any other `DSH_HOME` is taken
 * at its word — the point is to make the accident impossible, not to police where
 * a scratch directory lives.
 */
function useScratchHome() {
	const target = process.env.DSH_HOME
	const isReal = target !== undefined && (resolve(target) === resolve(join(homedir(), '.dsh')) || resolve(target) === resolve(homedir()))
	if (target !== undefined && target.trim() !== '' && !isReal) return
	const scratch = process.env.DSH_TABS_TEST_HOME ?? join(tmpdir(), 'dsh-tabs-smoke-test')
	rmSync(scratch, { recursive: true, force: true })
	mkdirSync(scratch, { recursive: true })
	process.env.DSH_HOME = scratch
	if (isReal) console.log(`refusing to touch the real device book; using ${scratch} instead`)
	return scratch
}

const SCRATCH = useScratchHome()

useScratchHome()

const require = createRequire(import.meta.url)
const remote = require(join(ROOT, 'src', 'remote.js'))
const devices = require(join(ROOT, 'src', 'devices.js'))

let failed = 0
let passed = 0
let skipped = 0

/**
 * Run one named check.
 * @param name - the check's description.
 * @param body - the assertions.
 */
async function test(name, body) {
	try {
		await body()
		passed += 1
		console.log(`  ok  ${name}`)
	} catch (error) {
		failed += 1
		console.error(`FAIL  ${name}`)
		console.error(`      ${error instanceof Error ? error.message : String(error)}`)
	}
}

/** The fixture device every builder test starts from. */
const device = { id: 'dev-1', label: 'box-a', transport: 'ssh', host: '10.0.0.2', user: 'deploy', sshPort: 22, directory: '~/work' }

console.log('remote programs')

await test('POSIX: one shell argument, wrapped once', () => {
	const command = remote.remoteCommand(remote.remoteProgram(device, 'posix'), 'posix')
	assert.ok(command.startsWith("bash -lic '"))
	assert.ok(command.endsWith("'"))
	assert.equal(command.split('bash -lic').length, 2)
})

await test('POSIX: the shell is interactive so ~/.bashrc exports survive', () => {
	// DEEPSEEK_API_KEY lived in ~/.bashrc, bash sources that only for INTERACTIVE
	// shells, so a non-interactive launch stripped it and the remote Harness asked
	// for a key the machine already had. PATH fails the same way.
	assert.match(remote.remoteDsh('--version', 'posix'), /^bash -lic '/u)
	assert.match(remote.remoteCommand('true', 'posix'), /^bash -lic /u)
})

await test('POSIX: the server lifetime is bound to stdin EOF, not to signals', () => {
	// A plain `exec dsh web` survived the client being killed outright and left an
	// orphan holding the remote port. Blocking on stdin is deterministic.
	assert.match(remote.posixProgram(device), /cat > \/dev\/null/u)
})

await test('POSIX: the server always asks for an OS-assigned port', () => {
	assert.match(remote.posixProgram(device), /dsh web --no-open --port 0/u)
})

await test('POSIX: a tilde directory expands instead of being quoted literally', () => {
	// `cd '~/x'` does not work: the quotes that make it injection-safe also
	// suppress the expansion, so the path is looked up literally.
	assert.equal(remote.remoteCd('~'), 'cd "$HOME"')
	assert.equal(remote.remoteCd('~/proj'), 'cd "$HOME"/\'proj\'')
	assert.equal(remote.remoteCd('/srv/x'), "cd '/srv/x'")
})

await test('POSIX: an embedded quote cannot escape the quoting', () => {
	assert.equal(remote.shellSingleQuote("a'b"), "'a'\\''b'")
})

console.log('windows remotes')

await test('Windows: the script is encoded past every layer', () => {
	// ssh joins its argv, the remote runs it through cmd.exe, and the script is
	// full of characters cmd would otherwise eat. Base64 has no spaces or quotes.
	const program = remote.remoteProgram(device, 'windows')
	const command = remote.remoteCommand(program, 'windows')
	assert.match(command, /^powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/u)
	assert.equal(command.split(' ').length, 7)
	assert.equal(Buffer.from(command.split(' ').pop(), 'base64').toString('utf16le'), program)
})

await test('Windows: the stdin-EOF teardown contract is kept', () => {
	const program = remote.windowsProgram(device)
	assert.match(program, /\[Console\]::In\.ReadToEnd\(\)/u)
	// The whole TREE, not just the process started: the launcher names the
	// interpreter and the script rather than the `.cmd` shim, so what it starts is
	// `node` itself — and `/T` still covers whatever the Harness spawns under it.
	assert.match(program, /taskkill \/PID \$proc\.Id \/T \/F/u)
	// stdout must be INHERITED: a redirect through a temp file would make the
	// readiness line's readability depend on a file-sharing mode.
	assert.doesNotMatch(program, /RedirectStandard/u)
	assert.match(program, /'web','--no-open','--port','0'/u)
})

await test('Windows: a shim with no bin.js is refused by name, not launched', () => {
	// The launcher starts the interpreter on `bin.js`, never the `.cmd` shim, so a
	// missing `bin.js` has no fallback that works: naming the shim would
	// reintroduce the failure the resolution exists to avoid, and naming no script
	// at all runs `node web --no-open --port 0`, which exits on
	// `Cannot find module …\web` and blames an argument rather than the install.
	const program = remote.windowsProgram(device)
	assert.doesNotMatch(program, /\{ \$binJs = \$dsh \}/u)
	assert.match(program, /\$argv = @\(\$binJs\)/u)
	assert.match(program, /\[Console\]::Error\.WriteLine\("dsh is at \$dsh, but \$binJs does not exist/u)
})

await test('Windows: dsh is found without nvm or a login shell', () => {
	const program = remote.windowsProgram(device)
	assert.match(program, /Get-Command dsh/u)
	assert.match(program, /\$env:APPDATA\\npm\\dsh\.cmd/u)
	assert.match(program, /exit 127/u)
})

await test('Windows: a tilde directory is translated, not passed to Set-Location', () => {
	const program = remote.windowsProgram(device)
	assert.match(program, /\$dir = '~\/work'/u)
	assert.match(program, /Join-Path \$env:USERPROFILE/u)
})

await test('Windows: no statement boundary lands inside the tilde if/elseif chain', () => {
	// **This is the check that would have caught a real bug, on a real host.**
	//
	// The program's statements are joined with `'; '`, and the tilde translation was
	// written as three of them — so the emitted text contained `… { … }; elseif (…) { … }`.
	// PowerShell ends the statement at that semicolon and then reads `elseif` as a
	// *command name*:
	//
	//   elseif : The term 'elseif' is not recognized as the name of a cmdlet,
	//   function, script file, or operable program.
	//
	// Measured against box-b, from the far side's own stderr, after a device
	// configured `~/AppData` silently failed to change directory. Nothing offline
	// noticed for as long as the branch existed, because every check looked for
	// fragments like `Join-Path $env:USERPROFILE` — which were present and correct in
	// a program that could not run.
	//
	// So this asserts the *join*, not the content: no `}` may be followed by a
	// semicolon and a PowerShell keyword, whatever the chain looks like later.
	const withDirectory = remote.windowsProgram({ ...device, directory: '~/work' })
	for (const keyword of ['elseif', 'else', 'catch', 'finally']) {
		assert.doesNotMatch(
			withDirectory,
			new RegExp(`\\}\\s*;\\s*${keyword}\\b`, 'u'),
			`a statement boundary splits a ${keyword} off from its block, which PowerShell reads as a command name`
		)
	}
	// And the chain is really there, so the negative check above cannot pass by the
	// translation having been deleted.
	assert.match(withDirectory, /if \(\$dir -eq '~'\) \{ \$dir = \$env:USERPROFILE \} elseif \(/u)
})

console.log('platform classification')

await test('a POSIX host is recognised by uname', () => {
	for (const name of ['Linux', 'Darwin', 'FreeBSD', 'linux\n']) {
		assert.equal(remote.classifyPlatform(0, name).platform, 'posix', name)
	}
})

await test('a Windows host is whatever uname did not answer', () => {
	// cmd.exe and PowerShell both fail `uname -s` and put nothing on stdout.
	assert.equal(remote.classifyPlatform(1, '').platform, 'windows')
	assert.equal(remote.classifyPlatform(9009, '').platform, 'windows')
})

await test('only ssh\'s own exit code means the connection failed', () => {
	// 255 must not be mistaken for a platform: an unreachable host has to fail
	// once, with the ssh error, instead of twice under a platform guess.
	assert.equal(remote.classifyPlatform(255, '').error, true)
	assert.equal(remote.classifyPlatform(255, 'Linux').error, true)
})

await test('the readiness URL is split into a port and a token', () => {
	const parsed = remote.parseReadyUrl('http://127.0.0.1:55359/?token=abc123')
	assert.equal(parsed.port, 55359)
	assert.equal(parsed.token, 'abc123')
})

console.log('ssh options')

await test('BatchMode forbids the password prompt a GUI cannot answer', () => {
	const options = remote.sshOptions(device)
	const at = options.indexOf('BatchMode=yes')
	assert.ok(at > -1)
	assert.equal(options[at - 1], '-o')
})

await test('the ssh port is carried, and defaults to 22', () => {
	assert.ok(remote.sshOptions(device).includes('22'))
	assert.ok(remote.sshOptions({ ...device, sshPort: 2222 }).includes('2222'))
	assert.ok(remote.sshOptions({ ...device, sshPort: undefined }).includes('22'))
})

console.log('local tab')

await test('the local Harness launches the way that actually works per platform', () => {
	// POSIX reuses the remote program, so the local tab gets the same stdin-EOF
	// teardown a remote tab has.
	const posix = remote.localDshArgv('linux')
	assert.equal(posix[0], 'bash')
	assert.equal(posix[1], '-lic')
	assert.equal(posix[2], remote.posixProgram({}))

	// Windows does NOT, and that is measured rather than preferred. Wrapping it in
	// the same PowerShell program is the obvious symmetry and it is wrong:
	// `Start-Process -NoNewWindow` gives the server no usable stdout when
	// PowerShell was itself spawned with pipes — measured, no output at all for
	// 30 s — while `cmd /c` announces its URL in 1.5 s.
	const win = remote.localDshArgv('win32')
	assert.match(win[0], /cmd\.exe$/u)
	assert.equal(win[1], '/c')
	assert.equal(win[2], 'dsh web --no-open --port 0')
})

await test('the local Harness is reaped by a tree kill, not by its own shell', () => {
	// Since the Windows local tab has no stdin contract, something else has to walk
	// the tree: it is `cmd.exe` → `dsh.cmd` → `node`, and killing one leaves two.
	const source = readFileSync(join(ROOT, 'src', 'connect.js'), 'utf8')
	assert.match(source, /function stopLocal\(child\)/u)
	// Synchronous: an async taskkill is a child of the quitting application and dies
	// with it before it has done anything — which is how it leaked the first time.
	assert.match(source, /spawnSync\('taskkill', \['\/PID', String\(child\.pid\), '\/T', '\/F'\]/u)
	// And the application must not rely on the shell's own `finally`: a terminated
	// application takes the shell down before that block runs.
	assert.match(source, /if \(process\.platform === 'win32'\)/u)
})
console.log('device book')

await test('a device is rebuilt from a whitelist', () => {
	const normalized = devices.normalize({ host: 'h', user: 'u', evil: 'x' })
	assert.equal(normalized.host, 'h')
	assert.equal(normalized.user, 'u')
	assert.equal(normalized.sshPort, 22)
	assert.equal('evil' in normalized, false)
})

await test('the detected platform survives an edit', () => {
	// The record is rebuilt rather than merged, so dropping this field would
	// silently re-probe the far side on the next connect.
	const normalized = devices.normalize({ id: 'd', host: 'h', user: 'u' }, { platform: 'windows' })
	assert.equal(normalized.platform, 'windows')
})

await test('an explicit platform wins over the cached one', () => {
	assert.equal(devices.normalize({ id: 'd', host: 'h', user: 'u', platform: 'posix' }, { platform: 'windows' }).platform, 'posix')
})

await test('an empty directory is not stored', () => {
	assert.equal('directory' in devices.normalize({ host: 'h', user: 'u', directory: '' }), false)
})

console.log('agreement with the plugin')

/**
 * Pull one function's source out of a module's text.
 *
 * Both files are written with `function name(...)` and a closing brace in column
 * zero, so the next such line ends the body. Parsing is not needed for a structural
 * equality check.
 *
 * `export ` in front is stripped, because the plugin exports the same builders this
 * application keeps private, and an exported copy is not a different builder.
 *
 * @param source - the module text.
 * @param name - the function name.
 * @returns the normalized body, or undefined when absent.
 */
function extract(source, name) {
	const start = source.indexOf(`function ${name}(`)
	if (start === -1) return undefined
	const end = source.indexOf('\n}\n', start)
	if (end === -1) return undefined
	return source
		.slice(start, end + 2)
		.replace(/^\s*export\s+/u, '')
		.replace(/\s+/gu, ' ')
		.trim()
}

await test('every copied builder is byte-identical to the plugin\'s', () => {
	// The plugin is the original; this app carries a copy so it stays
	// self-contained. Nothing else keeps the two honest, so this does.
	if (PLUGIN === undefined) {
		// Not a silent pass. Losing this check is losing the only thing that
		// notices the copy drifting, so say so where it can be seen.
		skipped += 1
		console.log('  SKIP the reference plugin is not on this machine; set DSH_REMOTE_DEVICES_PLUGIN to check the copy')
		return
	}
	const plugin = readFileSync(PLUGIN, 'utf8')
	const mine = readFileSync(join(ROOT, 'src', 'remote.js'), 'utf8')
	const shared = [
		'readyUrl',
		'shellSingleQuote',
		'resolvePreamble',
		'remoteCd',
		'posixProgram',
		'windowsLiteral',
		'windowsResolve',
		'windowsProgram',
		'windowsCommand',
		'remoteCommand',
		'remoteProgram',
		'remoteDsh',
		'sshOptions'
	]
	for (const name of shared) {
		const original = extract(plugin, name)
		assert.ok(original !== undefined, `${name} is missing from the plugin`)
		assert.equal(extract(mine, name), original, `${name} has drifted from the plugin`)
	}
})

await test('the platform rule in this copy is the one the plugin actually applies', () => {
	// **`platform` is the one shared rule with no copied function to compare, and it
	// was therefore the one shared rule nothing watched.** The plugin used to inline it
	// inside `detectPlatform` — the POSIX name match and the `exitCode === 255` failure
	// test — and that body cannot be compared, because the rest of it is
	// `ctx.subprocess` calls this application does not have. A change to the regex or to
	// the 255 regenerated nothing and failed nothing: the thirteen byte-identical
	// builders above do not reach it, and the contract is generated from *this* copy, so
	// it would have re-pinned the drift as if it were the protocol.
	//
	// **The plugin has since given the rule a name**, `classifyRemotePlatform(stdout)`,
	// which makes it comparable after all — and it is compared here in both halves: the
	// name match itself, byte for byte, and the `255` test that stayed behind in
	// `detectPlatform` because it is about an exit code rather than about output.
	if (PLUGIN === undefined) {
		skipped += 1
		console.log('  SKIP the reference plugin is not on this machine; the platform rule is pinned to this copy only')
		return
	}
	const plugin = readFileSync(PLUGIN, 'utf8')
	const mine = readFileSync(join(ROOT, 'src', 'remote.js'), 'utf8')
	const original = extract(plugin, 'classifyRemotePlatform')
	if (original === undefined) {
		// The older shape: the rule inlined in `detectPlatform`, where only its literal
		// can be reached. Said out loud rather than passed over, because a narrowed
		// check that reports nothing is the failure this whole block exists for.
		skipped += 1
		console.log('  SKIP the plugin inlines the platform rule; nothing compares it, and `platform.*` is pinned to this copy only')
		return
	}
	// **The comparison is the rule, not the function that wraps it.** The plugin's
	// classifier takes stdout alone — its caller tests the exit code first — while this
	// copy takes both and answers the failure itself, so the two function bodies cannot
	// be equal and should not be. What must be identical is the decision they make
	// about a host's output, and that is one expression:
	//
	//     <literal>.test(String(stdout ?? '').trim()) ? 'posix' : 'windows'
	//
	// The literal is the half a change would quietly break, and it is compared as
	// source text from each side rather than derived from one of them, so a change to
	// *either* file fails here.
	const rule = /(\/[^/\n]+\/[a-z]*)\.test\(String\(stdout[^)]*\)\.trim\(\)\) \? 'posix' : 'windows'/u
	const pluginRule = rule.exec(original)
	const mineRule = rule.exec(extract(mine, 'classifyPlatform'))
	assert.ok(pluginRule !== null, `the plugin's classifier no longer states its rule in a form this check can read: ${original}`)
	assert.ok(mineRule !== null, 'classifyPlatform no longer states its rule in a form this check can read')
	assert.equal(
		mineRule[1],
		pluginRule[1],
		`the plugin classifies with ${pluginRule[1]} and this copy with ${mineRule[1]}`
	)
	// Guards on the guard: two matchers agreeing on a literal neither of them has
	// actually run is what a broken pattern looks like, so the literal is checked
	// against the live function as well — rebuilt from its own source and flags.
	const [, literal, flags] = /^(\/[^/\n]+\/)([a-z]*)$/u.exec(pluginRule[1]) ?? []
	assert.ok(literal !== undefined, `the captured rule is not a regular expression literal: ${pluginRule[1]}`)
	assert.ok(
		new RegExp(literal.slice(1, -1), flags).test('Linux'),
		`${pluginRule[1]} does not match a POSIX host name`
	)
	assert.equal(remote.classifyPlatform(0, 'Linux\n').platform, 'posix')
	assert.equal(remote.classifyPlatform(1, '').platform, 'windows')
	// The failure code: ssh's own 255 must keep meaning "the connection failed" rather
	// than becoming a platform guess, on both sides.
	assert.match(plugin, /if \(outcome\.exitCode === 255\)/u, 'the plugin no longer treats 255 as its own failure')
	assert.match(mine, /if \(exitCode === 255\) return \{ error: true \}/u, 'classifyPlatform no longer treats 255 as a failure')
	// And the rule at the values the contract's own check uses, so a comparison that
	// somehow matched nothing cannot pass on its own.
	assert.equal(remote.classifyPlatform(255, '').error, true)
})

await test('the drift check would actually fail', () => {
	// A guard on the guard: if `extract` silently returned undefined for both
	// sides, the agreement test above would pass while comparing nothing.
	const source = readFileSync(join(ROOT, 'src', 'remote.js'), 'utf8')
	assert.ok(extract(source, 'resolvePreamble') !== undefined)
	assert.equal(extract(source, 'noSuchFunctionAnywhere'), undefined)
})

/**
 * The README, which is the only runbook this project has.
 *
 * Read here rather than beside its first use, because two blocks check it: the
 * prose contract below and the documentation checks further down. A `const` in
 * the later block is in the temporal dead zone for the earlier one — which is a
 * `ReferenceError`, not a failed assertion, and it is how this file learned to
 * declare shared inputs up front.
 */
const README = readFileSync(join(ROOT, 'README.md'), 'utf8')

console.log('launch directories, which arrive from the device book and end up in shells')

/**
 * Characters that mean something to one of the three shells this application
 * embeds a launch directory into. Every one of them has to end up inert.
 */
const HOSTILE_DIRECTORIES = [
	'~/work" & calc.exe & "',
	'~/work; rm -rf /',
	'~/work`id`',
	'~/work$(id)',
	'~/work|whoami',
	"~/work' ; id ; '",
	'~/work%USERPROFILE%',
	'C:\\work" & calc.exe & "',
	"C:\\work'; id; '"
]

await test('a hostile launch directory cannot become a command', () => {
	// The defect this exists for was in exactly one of four branches. `cmd /c`
	// takes a single command string and `cd /d` needs its path quoted, so a
	// directory containing a double quote closed the quote and the rest became a
	// new command:
	//
	//   directory  ~/work" & calc.exe & "
	//   cmd /c     cd /d "~/work" & calc.exe & "" && dsh web --no-open --port 0
	//
	// The other three branches already escaped — `shellSingleQuote` for POSIX,
	// `windowsLiteral` inside the `-EncodedCommand` script for a Windows remote —
	// and this test holds all of them to it, because the two that look safe are
	// only safe by way of a helper that a future edit could stop using.
	for (const directory of HOSTILE_DIRECTORIES) {
		const device = { host: 'build-01.example.net', user: 'deploy', sshPort: 22, directory }

		// POSIX: the value must appear only through `shellSingleQuote`, on exactly
		// the slice `remoteCd` is supposed to pass it — the `~` comes off first and
		// the remainder is what gets quoted. Stated that way, the check also catches
		// a branch that stopped using the escaper, which a `includes("'…'")` test
		// would miss for any value with an apostrophe in it.
		const quoted = remote.shellSingleQuote(directory.startsWith('~/') ? directory.slice(2) : directory)
		const posix = remote.posixProgram(device)
		assert.ok(posix.includes(quoted), `POSIX did not quote ${JSON.stringify(directory)}`)

		// A Windows remote: a PowerShell single-quoted literal, quotes doubled.
		const windows = remote.windowsProgram(device)
		assert.ok(
			windows.includes(`$dir = '${directory.replaceAll("'", "''")}'`),
			`PowerShell embedded ${JSON.stringify(directory)} unquoted`
		)

		// The local Windows tab: the branch that cannot quote, so it must refuse.
		if (directory.includes('"') || directory.includes("'") || /[%!&|<>^]/u.test(directory)) {
			assert.throws(
				() => remote.localDshArgv('win32', directory),
				/cannot be passed to a shell safely/u,
				`cmd /c accepted ${JSON.stringify(directory)}`
			)
			assert.ok(remote.directoryProblem(directory) !== null, `${JSON.stringify(directory)} was not flagged`)
		}
	}
})

await test('a directory that needs no escaping is still accepted everywhere', () => {
	// A guard on the guard: a validator that refused everything would pass the test
	// above while making the feature unusable. These are the shapes the field is
	// actually for, and each has to survive all four branches and the contract.
	const fine = ['/srv/dsh', '~/work/dsh', 'C:\\work\\dsh', 'C:\\Program Files\\dsh', '~/a-b_c.d']
	for (const directory of fine) {
		assert.equal(remote.directoryProblem(directory), null, `${directory} was refused`)
		assert.ok(remote.posixProgram({ directory }).includes('cd '), `POSIX dropped ${directory}`)
		assert.ok(remote.windowsProgram({ directory }).includes('$dir = '), `PowerShell dropped ${directory}`)
		assert.ok(remote.localDshArgv('win32', directory)[2].includes(directory), `cmd /c dropped ${directory}`)
	}
	// No directory at all is the common case and must stay free.
	assert.equal(remote.directoryProblem(undefined), null)
	assert.equal(remote.directoryProblem(''), null)
	assert.equal(remote.localDshArgv('win32', undefined)[2], 'dsh web --no-open --port 0')
})

await test('no guest can reach the privileged bridge', () => {
	// `src/preload.js` exposes `window.dshTabs` — which can call `devices:save` and
	// therefore write every field of the device book, including the one that becomes
	// part of a shell program. That is fine for the chrome this application draws
	// and must never be true of a guest, because a guest renders a remote Harness's
	// own web UI, which is the least trusted content in the process tree.
	//
	// The isolation rests on the preload being given to exactly one web contents:
	// the embedding window. Guests get Electron's defaults — no preload, no
	// `nodeIntegration`, `contextIsolation` on — and the `webpreferences` attribute
	// on a `<webview>` tag cannot take that away, because it is ignored unless the
	// embedder explicitly enables it with `allowpopups`. Both halves are pinned
	// here, because either one changing alone silently opens the bridge.
	const main = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8')
	assert.equal(main.split('preload:').length - 1, 1, 'a preload is attached in more than one place')
	assert.match(main, /preload: join\(__dirname, 'preload\.js'\)/u)

	const html = readFileSync(join(ROOT, 'src', 'renderer', 'index.html'), 'utf8')
	assert.ok(!/<webview[^>]*\bpreload\b/iu.test(html), 'a webview declares its own preload')
	assert.ok(!/allowpopups/u.test(html), 'a webview was given allowpopups, which unblocks webpreferences')

	// And nothing in the guest path re-attaches one behind the renderer's back.
	const renderer = readFileSync(join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')
	assert.ok(!/createElement\('webview'\)[\s\S]{0,400}?preload/iu.test(renderer), 'the renderer sets a guest preload')
	assert.ok(!/setAttribute\(\s*'preload'/u.test(renderer), 'the renderer sets a guest preload attribute')
	// `will-attach-webview` is declared by Electron and unused here; that is the
	// decision, so record it rather than leaving it to be inferred.
	assert.equal(main.includes('will-attach-webview'), false, 'main.js now handles will-attach-webview; the guest policy needs reviewing')
})

console.log('the protocol a second client has to speak')

/** The generated protocol contract, which the Android client is ported from. */
const CONTRACT = JSON.parse(readFileSync(join(ROOT, 'docs', 'contract.json'), 'utf8'))

await test('the contract is current, not a stale generation', () => {
	// It is written by `tools/contract.cjs` and compared here, so it cannot drift
	// away from the code it describes. Comparing the serialization rather than the
	// parsed object also pins the formatting, which is what a regeneration diff
	// should contain: values, not whitespace.
	const onDisk = readFileSync(join(ROOT, 'docs', 'contract.json'), 'utf8')
	assert.equal(onDisk, `${JSON.stringify(CONTRACT, null, 2)}\n`, 'docs/contract.json is not in generated form')
})

await test('the contract agrees with the code it was generated from', () => {
	assert.equal(CONTRACT.readiness.linePattern, remote.READY_LINE.source)
	assert.equal(CONTRACT.readiness.lineFlags, remote.READY_LINE.flags)
	assert.equal(CONTRACT.budgets.startTimeoutMs, remote.START_TIMEOUT_MS)
	assert.equal(CONTRACT.budgets.probeTimeoutMs, remote.PROBE_TIMEOUT_MS)
	assert.equal(CONTRACT.budgets.tunnelTimeoutMs, remote.TUNNEL_TIMEOUT_MS)
	assert.equal(CONTRACT.budgets.defaultSshPort, remote.DEFAULT_SSH_PORT)
	const sample = { host: 'build-01.example.net', user: 'deploy', sshPort: 22 }
	assert.deepEqual(CONTRACT.sshOptions, remote.sshOptions(sample), 'the ssh options in the contract are not the ones the code sends')
	// The host-key policy is the security half of the same options, and the string
	// alone does not say which way it leans: `accept-new` reads like "no checking",
	// and the JVM library a port would use spells the permissive case almost
	// identically while accepting a *changed* key. So the argv has to carry the
	// strict form, and the contract has to say what that means.
	assert.equal(CONTRACT.hostKeys.policy, 'StrictHostKeyChecking=accept-new')
	assert.ok(CONTRACT.sshOptions.includes('StrictHostKeyChecking=accept-new'), 'the strict host-key policy is no longer passed to ssh')
	assert.equal(CONTRACT.sshOptions.includes('StrictHostKeyChecking=no'), false, 'ssh is now invoked with the permissive policy')
	assert.match(CONTRACT.hostKeys.changedHost, /refused/u, 'the contract no longer says a changed host key is refused')
	assert.match(CONTRACT.hostKeys.libraryWarning, /HostKeyRepository/u, 'the JSch warning lost the thing that fixes it')
	assert.equal(CONTRACT.platform.classifier.includes('classifyPlatform'), true)
	assert.equal(remote.classifyPlatform(0, 'Linux\n').platform, CONTRACT.platform.posixMatch)
	assert.equal(remote.classifyPlatform(1, '').platform, CONTRACT.platform.windowsMatch)
	// ssh's own failure code has to be reported as a connection failure rather
	// than mistaken for a platform — the one case where the probe proves nothing.
	assert.equal(remote.classifyPlatform(255, '').error, true)
	assert.equal(CONTRACT.platform.sshFailureExitCode, 255)
	// Every captured program is the function that produces it, byte for byte.
	for (const platform of ['posix', 'windows']) {
		const captured = CONTRACT.remoteProgram[platform]
		for (const variant of ['withoutDirectory', 'withDirectory']) {
			const directory = captured[variant].directory
			const device = directory === undefined ? sample : { ...sample, directory }
			assert.equal(captured[variant].program, remote.remoteProgram(device, platform), `${platform}.${variant}.program has drifted`)
			assert.equal(
				captured[variant].remoteCommand,
				remote.remoteCommand(remote.remoteProgram(device, platform), platform),
				`${platform}.${variant}.remoteCommand has drifted`
			)
		}
	}
})

await test('the documented readiness example really parses', () => {
	// The one value in the contract that is not derived from this repository: a
	// real readiness line from a real `dsh`. It is checked against the real reader
	// rather than described, because the format is the thing a second client can
	// get wrong while every offline check still passes.
	// Both halves are pinned: the line a real `dsh` printed, and the URL the real
	// reader gets out of it. The URL on its own is *not* enough to match — that is
	// the mistake this check was written after, and the reason `example` holds the
	// whole line.
	const line = `${CONTRACT.readiness.example}\n`
	const captured = remote.readyUrl(line)
	assert.equal(captured, CONTRACT.readiness.exampleUrl, 'the example line does not yield the documented URL')
	assert.equal(remote.readyUrl(`${CONTRACT.readiness.exampleUrl}\n`), null, 'a URL without the prefix must not match')
	assert.equal(remote.readyUrl(`${line}${line}`), CONTRACT.readiness.exampleUrl, 'the first complete line must win')
	const parsed = remote.parseReadyUrl(captured)
	assert.ok(Number.isInteger(parsed.port) && parsed.port > 0, 'the example carries no usable port')
	assert.equal(typeof parsed.token, 'string', 'the example carries no session token')
	// The reader's central rule: `\S+` will happily match a URL that a pipe split
	// mid-write, so **only complete lines count** until the process is known to
	// have stopped printing. Losing the last six characters makes the token
	// shorter, not the line partial — the newline is still there.
	const truncated = `${CONTRACT.readiness.example.slice(0, CONTRACT.readiness.example.length - 6)}\n`
	// What the reader answers with is the captured URL, never the line, so the
	// expected value is the line minus its `dsh web: ` prefix.
	const expected = truncated.trimEnd().replace(/^dsh web: /u, '')
	assert.equal(remote.readyUrl(truncated), expected, 'a short but complete line is still a complete line')
	// The same bytes with nothing behind them must not resolve, because a chunk
	// boundary is not evidence that the URL finished arriving.
	assert.equal(remote.readyUrl(truncated.trimEnd()), null, 'a trailing partial line was accepted as complete')
	assert.equal(
		remote.readyUrl(truncated.trimEnd(), true),
		expected,
		'a trailing partial line must be usable once the process has stopped printing'
	)
})

await test('the contract says the plugin, not this copy, is normative', () => {
	// The suite asserts byte-parity against the plugin, so the plugin is the
	// source and `src/remote.js` is the copy. A document that tells a second
	// client to port from "the normative description in src/remote.js" points at
	// the wrong authority, and the README said exactly that until this check
	// existed.
	assert.match(CONTRACT.source.normative, /plugin/u, 'the contract no longer names the plugin as the source')
	assert.match(CONTRACT.source.copy, /src\/remote\.js/u, 'the contract no longer names this repository\'s copy')
	const android = README.slice(README.indexOf('## Android:'), README.indexOf('## Test'))
	// The claims, not a phrasing: prose in this file is hard-wrapped and lives in
	// tables *and blockquotes*, so a regex pinned to one sentence fails on a
	// re-wrap while the meaning is intact. Both artefacts are stripped before
	// matching for that reason — collapsing whitespace alone leaves the `>` that
	// a blockquote puts at the start of every wrapped line.
	const prose = android.replace(/^\s*>/gmu, '').replace(/\s+/gu, ' ')
	assert.match(prose, /src\/remote\.js` is the copy, not the original/u, 'the README no longer says src/remote.js is a copy')
	assert.match(prose, /original is the `dsh-remote-devices` Desktop plugin/u, 'the README no longer names what the original is')
	assert.match(prose, /docs\/contract\.json/u, 'the README does not point at the contract')
})

await test('the directory rule is exercised, not just stated', () => {
	// Both platform branches exist to keep `~` expanding while the rest of the
	// path stays quoted. If a future edit flattened that, the captured strings for
	// a device with a directory would equal the ones without — and this check is
	// what notices, because the values themselves would still be self-consistent.
	for (const platform of ['posix', 'windows']) {
		const captured = CONTRACT.remoteProgram[platform]
		assert.notEqual(
			captured.withDirectory.program,
			captured.withoutDirectory.program,
			`${platform}: a launch directory no longer changes the program`
		)
		// The directory has to arrive **quoted**, and each platform quotes it its
		// own way, so the literal is stated per platform rather than derived from
		// the raw value: a Windows path carries backslashes that JSON escapes, and
		// comparing the raw string would test the escaping instead of the quoting.
		const literal = platform === 'posix' ? `'work/dsh'` : `'C:\\work\\dsh'`
		assert.ok(
			captured.withDirectory.program.includes(literal),
			`${platform}: the directory is not quoted as ${literal}`
		)
	}
	assert.match(CONTRACT.remoteProgram.posix.withDirectory.program, /cd "\$HOME"\/'work\/dsh'/u, 'the POSIX tilde split changed shape')
})

console.log('window wiring')

await test('shortcuts are handled in the main process, not the page', () => {
	// Key events do not cross into a <webview> guest, so a renderer-side listener
	// only fires while focus is in the app's own chrome — which is almost never,
	// because the operator is working inside a remote interface.
	const main = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8')
	assert.match(main, /web-contents-created/u)
	assert.match(main, /before-input-event/u)
	assert.match(main, /input\.alt/u)
	const renderer = readFileSync(join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')
	assert.doesNotMatch(renderer, /addEventListener\('keydown'/u)
})

await test('guests are wired through both hooks, and only once', () => {
	// The headline feature is "Alt+digit works while focus is inside a remote
	// interface", and it rests on the guest's contents being wired. Electron's own
	// definition of `web-contents-created` does not say guests are included, so the
	// app takes the second, documented route as well — and a set keeps the two from
	// double-firing.
	const main = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8')
	assert.match(main, /app\.on\('web-contents-created'/u)
	assert.match(main, /contents\.on\('did-attach-webview'/u)
	assert.match(main, /if \(wired\.has\(contents\)\) return/u)
	assert.match(main, /wired\.add\(contents\)/u)
	// Both hooks must funnel into the one wiring function, or one path would drift.
	// The call-site patterns tolerate indentation on purpose: anchoring them to an
	// exact tab depth makes the check fail on a reformat, which teaches nothing.
	assert.match(main, /function wireContents\(contents\)/u)
	assert.match(main, /\n\t+wireContents\(contents\)\n/u)
	assert.match(main, /\n\t+wireContents\(guest\)\n/u)
})

await test('the embedding window is the only one that needs webviewTag', () => {
	const main = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8')
	assert.match(main, /webviewTag: true/u)
	assert.match(main, /contextIsolation: true/u)
	assert.match(main, /nodeIntegration: false/u)
})

await test('quitting tears every tab down', () => {
	// A remote server that is never told to stop keeps holding its port.
	const main = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8')
	assert.match(main, /app\.on\('before-quit'/u)
	assert.match(main, /for \(const tab of tabs\.values\(\)\) stopTab\(tab\)/u)
	assert.match(main, /if \(connection !== undefined\) connection\.stop\(\)/u)
})

await test('the teardown contract is stdin first, then the kill', () => {
	// Killing the ssh client first would drop the connection without the far side
	// ever learning it should stop, leaving an orphaned server holding the port.
	const source = readFileSync(join(ROOT, 'src', 'connect.js'), 'utf8')
	const stop = source.indexOf('stop() {')
	assert.ok(stop > -1, 'connect() exposes stop()')
	const body = source.slice(stop, source.indexOf('\n\t\t}', stop))
	assert.ok(body.indexOf('stdin?.end()') < body.indexOf('tunnel.kill()'), 'stdin must be closed before the tunnel is killed')
	assert.match(body, /server\.exitCode === null/u)
})

await test('every web contents gets the window-open rule, guests included', () => {
	// Setting it only on the main window leaves a link clicked inside a remote
	// interface opening an unmanaged Electron window: no tab bar, no way back.
	const main = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8')
	// Exactly one place decides where a link goes; a second handler elsewhere would
	// silently overwrite this one and drift from it later.
	assert.equal(main.split('setWindowOpenHandler').length - 1, 1)
	const wiring = main.slice(main.indexOf('function wireContents'), main.indexOf("app.on('web-contents-created'"))
	assert.match(wiring, /contents\.setWindowOpenHandler/u)
	assert.match(wiring, /action: 'deny'/u)
	assert.match(wiring, /shell\.openExternal/u)
})

await test('none of the shell-coupling machinery reappeared', () => {
	// The objective was to drop the lease / webview / slot machinery the Desktop
	// shell requires. That machinery exists only because a plugin does not own its
	// window — the lease guard, the `about:blank#<lease>` attachment ritual, the
	// sidebar-browser frame attribute, the overlay seat. This app owns its window,
	// so any of it reappearing here would be a regression, not a feature.
	const forbidden = ['shell.overlay', 'slots.inject', 'browser-acquire', 'about:blank#', 'data-sidebar-browser-frame', 'ipcRenderer.invoke(\'dsh-desktop']
	for (const name of ['main.js', 'connect.js', 'remote.js', 'devices.js', 'preload.js', 'renderer/app.js']) {
		const source = readFileSync(join(ROOT, 'src', name.replace('/', join('/', ''))), 'utf8')
		for (const needle of forbidden) {
			assert.ok(!source.includes(needle), `${name} still contains ${needle}`)
		}
	}
})

await test('a Node-mode launch fails with the diagnosis, not a TypeError', () => {
	// With ELECTRON_RUN_AS_NODE set, Electron runs the entry point as a plain Node
	// script and `require('electron')` returns a **string** — the path to the
	// binary — so `app` is undefined and the first `app.on(...)` throws
	// `Cannot read properties of undefined (reading 'on')`: a message naming a line
	// of this file and not the cause, out of a launch npm reported as successful.
	//
	// The decision is a pure function of what `require('electron')` resolved to, so
	// it is tested by calling it rather than by matching its source text. That is
	// not stylistic: this is the one failure that *cannot* be reproduced here,
	// because the environment that causes it is the environment in which the app
	// cannot be started at all. Measured — running `electron.exe .` with
	// `ELECTRON_RUN_AS_NODE=0` still takes the Node path, so the flag is tested for
	// presence, not for a value, and there is no way to launch a window from a
	// shell that has it.
	const main = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8')
	const at = main.indexOf("typeof electronApp?.on === 'function'")
	assert.ok(at > -1, 'main.js no longer decides whether it is running under Electron')
	const close = main.indexOf('\n}', at)
	assert.ok(close > at, 'nodeModeDiagnosis is not a plain top-level function')
	// The function is self-contained — it closes over nothing — so it can be lifted
	// out of the source and called directly.
	const decide = new Function(`${main.slice(main.indexOf('function nodeModeDiagnosis'), close + 2)}; return nodeModeDiagnosis`)()

	// The real shape: Electron's `app` has `on`. The guard must not false-fire.
	assert.equal(decide({ on: () => {} }), null, 'the guard rejects a working Electron app')
	assert.equal(decide({ on() {}, whenReady: () => {} }), null, 'the guard rejects a working Electron app')
	// The Node-mode shape, measured: a string holding the binary path. Built from
	// this repository's own location rather than typed in, so moving the checkout
	// cannot leave a path here that describes a directory that no longer exists —
	// which is exactly what happened when the two repositories were consolidated
	// under one parent.
	const nodeModeValue = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
	const message = decide(nodeModeValue)
	assert.ok(typeof message === 'string', 'the guard accepts the string require(electron) returns in Node mode')
	assert.match(message, /ELECTRON_RUN_AS_NODE/u, 'the diagnosis does not name the variable')
	assert.match(message, /ELECTRON_RUN_AS_NODE = \$null/u, 'the diagnosis does not say how to clear it')
	assert.match(message, /unset ELECTRON_RUN_AS_NODE/u, 'the diagnosis has no POSIX remedy')
	// And the TypeError it replaces, kept honest: this is what the reader saw.
	assert.throws(() => {
		/** @type {any} */
		const app = undefined
		app.on('web-contents-created', () => {})
	}, /Cannot read properties of undefined|Cannot read property/u)

	// It has to stop the process and run before any Electron API is touched, or it
	// can never fire. API calls are matched as leading statements, because the
	// file's own comments quote `app.on(...)` while explaining this very guard.
	const guard = main.slice(main.indexOf('nodeModeDiagnosis(app)'), main.indexOf("const LOCAL_ID"))
	assert.match(guard, /process\.exit\(1\)/u, 'the guard does not stop the process')
	const firstCall = /^[ \t]*(?:app|ipcMain|shell)\.[A-Za-z]+\(|^[ \t]*new BrowserWindow\(/mu.exec(main)
	assert.ok(firstCall !== null, 'main.js no longer calls any Electron API')
	assert.ok(main.indexOf('nodeModeDiagnosis(app)') < firstCall.index, `the guard runs after ${firstCall[0].trim()}`)
	// The guard must consult the real `app`, not some other binding.
	assert.match(guard, /nodeModeDiagnosis\(app\)/u)
})

console.log('the documentation this app is debugged from')

await test('the README instructs a version check that the environment cannot poison', () => {
	// Measured: in a shell with ELECTRON_RUN_AS_NODE set, the documented
	// `electron.exe --version` answers `v24.18.1` for a healthy 44.0.0 binary.
	// The README therefore has to carry both the warning and the check that reads
	// the version out of the file, where no environment variable can reach it.
	assert.match(README, /ELECTRON_RUN_AS_NODE/u, 'the README does not mention the variable that breaks the check it documents')
	assert.match(README, /VersionInfo\.ProductVersion/u, 'the README has no environment-independent version check')
})

await test('every environment variable the README names is one the code reads', () => {
	// A documented knob that nothing reads is worse than no documentation: the
	// operator sets it, sees the same behaviour, and concludes the failure is
	// something else. This is the check that would have caught the README calling
	// the scratch-directory variable by a name no file contained.
	const sources = ['src/main.js', 'src/connect.js', 'src/devices.js', 'src/remote.js', 'src/localdsh.js', 'src/preload.js', 'tools/smoke.mjs', 'tools/main.mjs', 'tools/renderer.mjs', 'tools/live-connect.mjs', 'tools/connect.mjs', 'tools/readiness.cjs', 'tools/contract.cjs']
	const code = sources.map((file) => readFileSync(join(ROOT, file), 'utf8')).join('\n')
	const documented = new Set([...README.matchAll(/`(DSH_[A-Z0-9_]+)`/gu)].map((match) => match[1]))
	assert.ok(documented.size > 0, 'the README documents no DSH_ environment variable')
	for (const name of documented) {
		assert.ok(code.includes(name), `the README documents ${name} but no source file mentions it`)
	}
	// The reverse direction is not required — the suites read variables the README
	// has no reason to document — but the one that selects the scratch directory
	// is documented and the spelling is load-bearing, so pin it.
	assert.ok(documented.has('DSH_TABS_TEST_HOME'), 'the README no longer documents DSH_TABS_TEST_HOME')
	assert.match(readFileSync(join(ROOT, 'tools', 'main.mjs'), 'utf8'), /DSH_TABS_TEST_HOME/u)
})

await test('no heading in the README is empty', () => {
	// A heading with nothing under it reads as a section that was meant to exist.
	// One did: a duplicate `### The Electron version is pinned` with three blank
	// lines beneath it, left behind by an edit.
	const lines = README.split(/\r?\n/u)
	for (const [index, line] of lines.entries()) {
		if (!/^#{1,6} /u.test(line)) continue
		const rest = lines.slice(index + 1).filter((next) => next.trim() !== '')
		assert.ok(rest.length > 0, `the README ends with an empty heading: ${line}`)
		assert.ok(!/^#{1,6} /u.test(rest[0]), `the heading "${line}" has no content under it`)
	}
})

await test('every local link in the README resolves to a file', () => {
	// The studies this app is decided by live in `docs/`, and the README is the
	// only door to them: a path that has been moved or renamed is a dead end that
	// nothing else would notice, because no source file names those documents.
	// External links are not fetched — this suite is offline by design.
	const links = [...README.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)].map((match) => match[1])
	const local = links.filter((href) => !/^[a-z][a-z0-9+.-]*:/iu.test(href) && !href.startsWith('#'))
	for (const href of local) {
		const target = decodeURIComponent(href.split('#')[0])
		assert.ok(
			existsSync(join(ROOT, target)),
			`the README links to ${href}, which is not in this repository`
		)
	}
	assert.ok(local.length >= 2, 'the README no longer links to the feasibility studies')
})

console.log('what this repository is allowed to carry')

/**
 * The repository is about to be somebody else's checkout, and two kinds of string
 * must not survive the trip: a path that only exists on the machine this was built
 * on, and anything that describes that machine's owner or their network.
 *
 * The checks below are deliberately pattern-based rather than a list of the names to
 * avoid. **A check that spells out a secret publishes it**, and the file that
 * enforces this rule is read by exactly the people the rule protects it from.
 */

/**
 * Every drive-absolute path this repository may contain, with what it is.
 *
 * A fixture is not a location: these are strings that make a shell or a quoting rule
 * do something, and none of them is expected to exist anywhere.
 */
const ALLOWED_ABSOLUTE = [
	'C:\\Windows', // the OS's own directory: the fallback when `SystemRoot` is unset
	'C:\\work', // the fixture launch directory, in every branch that quotes one
	'C:\\Program', // the same fixture with a space in it; the match stops at the space
	'C:\\nope', // a transcript fixture for a `Set-Location` that failed
	'C:\\definitely-not-a-directory-dsh-tabs', // the README's measured example of that same failure
	'C:\\…', // an elided path: the redacted form is allowed, the real one is not
	'C:\\Users\\…'
]

/**
 * A drive-absolute path, and the two things that keep this from matching code.
 *
 * The drive letter must be **uppercase** and must not follow a letter. Without both
 * rules this fires on things that are not paths at all: a regular expression's
 * `\b:\s*` reads as drive `b`, `http:\/\/` reads as drive `p`, and a template
 * literal's `\n${…}` reads as drive `n`. Every one of those is lowercase, and every
 * drive letter written in this repository is not.
 */
const DRIVE_PATH = /(?<![A-Za-z])[A-Z]:\\[^\s"'`|<>()[\]]*/gu

/**
 * Addresses that may appear: loopback, the unspecified address, one Windows
 * capability name that only looks like an address, and the two fixtures.
 */
const ALLOWED_ADDRESSES = new Set(['0.0.0.0', '0.0.1.0', '127.0.0.0', '127.0.0.1', '10.0.0.2', '10.0.0.3'])

/** Ranges that describe somebody's network rather than an example. */
const PRIVATE_RANGE = /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/u

/** A user profile, in the three spellings that reach a published file. */
const PROFILE_PATHS = [
	/[A-Za-z]:\\Users\\(?!…)/u,
	/\/Users\/[A-Za-z0-9._-]+\//u,
	/\/home\/[A-Za-z0-9._-]+\//u
]

/**
 * Every text file this repository would hand to a clone.
 *
 * Directories the suites and capture runs create are skipped: they hold the
 * operator's own data by design, and `.gitignore` is what keeps them out of a commit.
 */
function repositoryFiles() {
	const SKIP = new Set(['node_modules', '.git', '.shots', '.tmp', '.tmp-main-test', '.research', '.ssh-research'])
	const TEXT = /\.(?:md|js|mjs|cjs|json|html|css|ps1|sh|yml|yaml|txt|svg|xml)$/u
	const NAMES = new Set(['LICENSE', '.gitignore', '.gitattributes'])
	const files = []
	const walk = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (SKIP.has(entry.name)) continue
			const path = join(directory, entry.name)
			if (entry.isDirectory()) walk(path)
			else if (TEXT.test(entry.name) || NAMES.has(entry.name)) files.push(path)
		}
	}
	walk(ROOT)
	return files
}

const REPOSITORY_FILES = repositoryFiles()

/**
 * One file's lines, prepared for matching.
 *
 * URLs are removed first, because a URL's path segments look like a filesystem path
 * and `github.com/home/user` is nobody's home directory. Doubled backslashes are
 * collapsed, because `'C:\\work'` in JavaScript and `"C:\\work"` in JSON both name
 * `C:\work` and the check has to read what the string means, not how it is escaped.
 *
 * @param file - the file to read.
 * @returns the prepared lines with their numbers.
 */
function preparedLines(file) {
	return readFileSync(file, 'utf8')
		.split(/\r?\n/u)
		.map((text, index) => ({
			number: index + 1,
			text: text.replace(/https?:\/\/\S+/gu, '').replace(/\\\\/gu, '\\')
		}))
}

await test('no file names a directory that only exists on the machine this was built on', () => {
	const offences = []
	for (const file of REPOSITORY_FILES) {
		for (const { number, text } of preparedLines(file)) {
			for (const match of text.matchAll(DRIVE_PATH)) {
				if (ALLOWED_ABSOLUTE.some((allowed) => match[0].startsWith(allowed))) continue
				offences.push(`${relative(ROOT, file)}:${number}  ${match[0]}`)
			}
		}
	}
	assert.deepEqual(
		offences,
		[],
		`a drive-absolute path a reader cannot resolve:\n${offences.join('\n')}\n` +
			'Write the place, not the path: `<root>\\dsh-electron-test`, or an elided `C:\\…`.'
	)
})

await test('no file names a user profile, a private address or somebody\'s machine', () => {
	const offences = []
	for (const file of REPOSITORY_FILES) {
		for (const { number, text } of preparedLines(file)) {
			for (const pattern of PROFILE_PATHS) {
				const match = pattern.exec(text)
				if (match !== null) offences.push(`${relative(ROOT, file)}:${number}  ${match[0]}  (a user profile)`)
			}
			for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu)) {
				if (ALLOWED_ADDRESSES.has(match[0])) continue
				if (!PRIVATE_RANGE.test(match[0])) continue
				offences.push(`${relative(ROOT, file)}:${number}  ${match[0]}  (a private address)`)
			}
		}
	}
	assert.deepEqual(
		offences,
		[],
		`something that describes the machine this was built on:\n${offences.join('\n')}\n` +
			'Use the loopback address, a documentation range, or one of the fixtures.'
	)
})

await test('the screenshots a capture run produces cannot be committed by accident', () => {
	// They are evidence, and they show a real device book: host names, SSH users and
	// the operator's own machines in the tab bar. `tools/shot.ps1` writes them into
	// `.shots`, and a directory left out of `.gitignore` is one `git add -A` away
	// from being published.
	const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
	assert.match(ignore, /^\.shots\/$/mu, '.shots/ is not ignored, so a capture run can be committed')
	assert.match(ignore, /^node_modules\/$/mu, 'node_modules/ is not ignored')
})

await test('the two guards above would actually fire', () => {
	// A guard that has never been seen to fail is a guard that may be matching
	// nothing at all — and these two are the kind that fail silently, because a
	// pattern that stopped matching reports exactly what a clean repository reports.
	//
	// The samples are assembled rather than written out. This file is scanned by the
	// checks it defines, so a literal here would be an offence in it.
	const profile = ['C:', 'Users', 'someone', 'work', 'dsh'].join('\\')
	const found = [...profile.matchAll(DRIVE_PATH)].map((match) => match[0])
	assert.ok(found.length > 0, 'the drive-path pattern no longer matches a drive path')
	assert.ok(
		!ALLOWED_ABSOLUTE.some((allowed) => found[0].startsWith(allowed)),
		'a path belonging to somebody is on the allowlist'
	)
	assert.ok(
		PROFILE_PATHS.some((pattern) => pattern.test(profile)),
		'the profile pattern no longer matches a user profile'
	)

	const address = ['192', '168', '1', '10'].join('.')
	assert.ok(PRIVATE_RANGE.test(address), 'the private-range pattern no longer matches a private address')
	assert.ok(!ALLOWED_ADDRESSES.has(address), 'a private address is on the allowlist')
})

console.log('the icon, which is generated and can therefore be regenerated wrong')

await test('the icon carries every size, and each entry is the image it claims to be', () => {
	// `assets/icon.ico` is built from `assets/icon.svg` by two scripts, and a
	// regeneration that goes wrong produces a file that still looks like a file: an
	// offset past the end, an entry whose declared size disagrees with its own image,
	// a missing 16-pixel rung. None of that is visible until it is on somebody's
	// desktop, and then it is an icon that draws as garbage.
	const ico = readFileSync(join(ROOT, 'assets', 'icon.ico'))
	assert.equal(ico.readUInt16LE(0), 0, 'the reserved field is not zero')
	assert.equal(ico.readUInt16LE(2), 1, 'the file does not declare itself an icon')
	const count = ico.readUInt16LE(4)
	assert.ok(count >= 6, `the icon has only ${String(count)} sizes`)

	const sizes = []
	for (let index = 0; index < count; index++) {
		const entry = 6 + index * 16
		const width = ico.readUInt8(entry) || 256
		const height = ico.readUInt8(entry + 1) || 256
		const length = ico.readUInt32LE(entry + 8)
		const offset = ico.readUInt32LE(entry + 12)
		assert.ok(offset + length <= ico.length, `entry ${String(index)} runs past the end of the file`)
		assert.equal(ico.readUInt32BE(offset), 0x89504e47, `entry ${String(index)} is not a PNG`)
		assert.equal(ico.readUInt32BE(offset + 16), width, `entry ${String(index)} disagrees about its width`)
		assert.equal(ico.readUInt32BE(offset + 20), height, `entry ${String(index)} disagrees about its height`)
		sizes.push(width)
	}
	// 16 is the size that decides whether the drawing works at all; 256 is what a shell
	// asks for when it wants a preview.
	for (const required of [16, 32, 48, 256]) {
		assert.ok(sizes.includes(required), `the icon has no ${String(required)} pixel entry`)
	}

	// Both drawings, because the .ico cannot be regenerated without them: the small
	// rungs come from `icon-small.svg` and every other size from `icon.svg`. Which
	// entry came from which file is not something this suite can see — that would need
	// a PNG decoder — so what it pins is that both sources are still here.
	for (const file of ['icon.svg', 'icon-small.svg', 'icon.ico', 'icon-256.png', 'icon-512.png']) {
		assert.ok(existsSync(join(ROOT, 'assets', file)), `assets/${file} is missing`)
	}
})

await test('no XML in this repository carries a comment a parser would reject', () => {
	// Measured, by the operator opening the file: `assets/icon.svg` said `--accent` and
	// `--bg` in its comment — CSS variables, which is how the palette is named
	// everywhere else in this project — and a double hyphen is not allowed inside an
	// XML comment. The browser showed a parse error and nothing else, which is a
	// spectacular way for an icon to fail: the file that draws the icon could not be
	// opened.
	//
	// The render pipeline did not catch it, and could not have: Chromium was handed the
	// SVG inside an HTML page, and HTML's parser is lenient about exactly this. Neither
	// does the .ico check above — the rasterised assets were correct, because the parser
	// that made them was the forgiving one.
	const files = REPOSITORY_FILES.filter((file) => /\.(?:svg|xml)$/u.test(file))
	assert.ok(files.length > 0, 'no SVG or XML file was scanned at all')
	for (const file of files) {
		const text = readFileSync(file, 'utf8')
		for (const comment of text.matchAll(/<!--([\s\S]*?)-->/gu)) {
			assert.doesNotMatch(comment[1], /--/u, `${relative(ROOT, file)}: a comment contains a double hyphen`)
			assert.doesNotMatch(comment[1], /-$/u, `${relative(ROOT, file)}: a comment ends with a hyphen`)
		}
	}
})

console.log('electron api contract')

/**
 * Read Electron's own type declarations.
 *
 * A GUI launch is not available while building this: the environment that runs
 * these suites sets `ELECTRON_RUN_AS_NODE`, and with that set — to any value,
 * including `0` — the Electron binary runs the entry point as plain Node, so no
 * window can be opened to observe anything in. An API used with the wrong name or
 * the wrong shape would then surface only as a runtime failure on the operator's
 * machine. Electron ships the answer, so the contract is checked against its own
 * declarations rather than assumed.
 *
 * @returns the declaration text.
 */
function electronTypes() {
	return readFileSync(join(ROOT, 'node_modules', 'electron', 'electron.d.ts'), 'utf8')
}

/**
 * The declared `Input` interface, which is what `before-input-event` hands over.
 * @returns the declaration block.
 */
function inputBlock() {
	const types = electronTypes()
	const at = types.indexOf('interface Input {')
	assert.ok(at > -1, 'the Input interface is declared')
	return types.slice(at, types.indexOf('\n  }', at))
}

await test('the Input object has the fields the shortcut reads', () => {
	// `input.code` is the layout-independent DOM code, which is why Alt+digit works
	// on a layout where the shifted digit is not a digit. `isAutoRepeat` matters:
	// holding the key would otherwise cycle through tabs.
	const block = inputBlock()
	for (const field of ['code: string', 'isAutoRepeat: boolean', 'alt: boolean', 'control: boolean', 'meta: boolean', 'shift: boolean', 'type: string']) {
		assert.ok(block.includes(field), `Input has no ${field}`)
	}
})

await test('the declaration confirms the semantics the router relies on', () => {
	// The router matches /^(?:Digit|Numpad)([1-9])$/ against `input.code`, and it
	// treats `input.type` as a plain string whose interesting value is `keyDown`.
	// Both of those are load-bearing and neither can be observed without launching
	// a window, so they are checked against Electron's own documentation.
	const block = inputBlock()
	assert.match(block, /Equivalent to KeyboardEvent\.code/u)
	assert.match(block, /Equivalent to KeyboardEvent\.repeat/u)
	assert.match(block, /Either `keyUp` or `keyDown`/u)
})

await test('every event and method the main process depends on exists', () => {
	const types = electronTypes()
	const wanted = [
		["on(event: 'web-contents-created'", 'App.on(web-contents-created)'],
		["on(event: 'before-quit'", 'App.on(before-quit)'],
		["on(event: 'before-input-event'", 'WebContents.on(before-input-event)'],
		["on(event: 'did-attach-webview'", 'WebContents.on(did-attach-webview)'],
		['setWindowOpenHandler(', 'WebContents.setWindowOpenHandler'],
		['openExternal(', 'shell.openExternal'],
		['titleBarOverlay?', 'BrowserWindow titleBarOverlay'],
		['titleBarStyle?', 'BrowserWindow titleBarStyle'],
		['trafficLightPosition?', 'BrowserWindow trafficLightPosition'],
		['webviewTag?', 'WebPreferences webviewTag'],
		['sandbox?: boolean', 'WebPreferences sandbox']
	]
	for (const [needle, label] of wanted) {
		assert.ok(types.includes(needle), `${label} is not in electron.d.ts`)
	}
})

await test('the connect path has no Electron dependency', () => {
	// Not a style preference: this is what lets tools/live-connect.mjs drive the
	// riskiest code in the app against a real device without a window. An
	// `require('electron')` anywhere in here would take that away.
	for (const name of ['connect.js', 'remote.js', 'devices.js']) {
		const source = readFileSync(join(ROOT, 'src', name), 'utf8')
		assert.doesNotMatch(source, /require\(['"]electron['"]\)/u, `${name} requires electron`)
	}
})

console.log('the device book')

await test('the device book is never read-modify-written unserialized', async () => {
	// `load()` then `save()` is a lost update the moment anything else writes in
	// between: the loser's changes vanish. It was not hypothetical here — every tab
	// activation persists a detected platform, and the popover edits the same file,
	// so clicking an uncached device while saving an edit could resurrect a device
	// that had just been removed or drop the edit that had just been saved.
	// Measured: the suite that drives both paths failed about one run in three.
	//
	// This runs against the real book in a scratch `DSH_HOME`, which `tools/main.mjs`
	// also uses — so it is written to be harmless, and it leaves the file as it found
	// it. The last change below re-saves the list it read.
	const book = require(join(ROOT, 'src', 'devices.js'))
	assert.equal(typeof book.mutate, 'function', 'devices.js no longer serializes book writes')

	// It has to actually serialize: a slow change must finish before the next one
	// reads, or the second would read the pre-change book. This is the whole
	// contract, and it is why the check does not merely grep for `mutate`.
	const seen = []
	await Promise.all([
		book.mutate(async () => {
			seen.push('a reads')
			await new Promise((resolve) => {
				setTimeout(resolve, 25)
			})
			seen.push('a writes')
			return []
		}),
		book.mutate((stored) => {
			seen.push(`b reads ${String(stored.length)}`)
			return stored
		})
	])
	assert.deepEqual(seen, ['a reads', 'a writes', 'b reads 0'], `a mutation ran before the previous one finished: ${seen.join(', ')}`)

	// A change that declines leaves the book alone rather than emptying it — the
	// shape `persistPlatform` uses when its device has since been removed.
	assert.equal(await book.mutate(() => undefined), undefined)

	// A rejected mutation must not poison the ones behind it, or one bad edit would
	// fail every later one with the same stale error.
	await assert.rejects(
		book.mutate(() => {
			throw new Error('deliberate')
		}),
		/deliberate/u
	)
	assert.ok(Array.isArray(await book.mutate((stored) => stored)), 'the chain was left rejected by a failed mutation')

	// And no handler may go back to doing it by hand. The scan is bounded so it
	// cannot match across two unrelated handlers.
	const main = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8')
	assert.doesNotMatch(main, /await devices\.load\(\)[\s\S]{0,400}?await devices\.save\(/u, 'a handler reads and writes the book without serialization')
})

await test('the content policy covers the chrome this app draws', () => {
	const html = readFileSync(join(ROOT, 'src', 'renderer', 'index.html'), 'utf8')
	assert.match(html, /Content-Security-Policy/u)
	assert.match(html, /default-src 'none'/u)
})

// Take the scratch book away again when this run created it. A directory left in
// the system temp directory for every run is the kind of litter that eventually
// gets mistaken for state.
if (SCRATCH !== undefined) rmSync(SCRATCH, { recursive: true, force: true })

console.log(`\n${String(passed)} checks passed${skipped === 0 ? '' : `, ${String(skipped)} skipped`}${failed === 0 ? '' : `, ${String(failed)} failed`}`)
if (failed > 0) process.exitCode = 1
