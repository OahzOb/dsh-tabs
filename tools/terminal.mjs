/**
 * Drive the terminal module with a fake pty.
 *
 * The interesting parts of a terminal are not the emulator and not the pty: they
 * are the argv that reaches ssh, the environment the far side inherits, and what
 * happens between "the process exists" and "the renderer has a screen" — which is
 * where a failed ssh prints the only sentence that explains it. Those are all
 * observable with a fake pty, and a fake is the only thing an offline suite can
 * have.
 *
 * `start` is also given a pty that throws, because the module's promise is that a
 * machine without the native binding breaks one terminal tab and not the
 * application.
 *
 * Usage: node tools/terminal.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const require = createRequire(import.meta.url)

const terminal = require(join(ROOT, 'src', 'terminal.js'))

let passes = 0
const failures = []

/**
 * Run one named check.
 * @param name - the check's description.
 * @param body - the assertions.
 */
async function test(name, body) {
	try {
		await body()
		passes += 1
		console.log(`  ok  ${name}`)
	} catch (error) {
		failures.push(name)
		console.error(`FAIL  ${name}`)
		console.error(`      ${error instanceof Error ? error.message : String(error)}`)
	}
}

/** One device, with a non-default port so the argv assertion has something to find. */
const DEVICE = { id: 'dev-a', label: 'box-a', transport: 'ssh', host: '10.0.0.2', user: 'deploy', sshPort: 2222 }

/**
 * A pty handle that records what the session does to it.
 * @returns the handle, with test-only `emit` and `exit`.
 */
function fakePty() {
	const dataListeners = []
	const exitListeners = []
	const writes = []
	const resizes = []
	let killed = 0
	return {
		pid: 4242,
		writes,
		resizes,
		onData(listener) {
			dataListeners.push(listener)
		},
		onExit(listener) {
			exitListeners.push(listener)
		},
		write(data) {
			writes.push(data)
		},
		resize(cols, rows) {
			resizes.push([cols, rows])
		},
		kill() {
			killed += 1
		},
		kills() {
			return killed
		},
		/** The far side printed something. */
		emit(data) {
			for (const listener of dataListeners) listener(data)
		},
		/** The ssh client ended. */
		exit(code = 0) {
			for (const listener of exitListeners) listener({ exitCode: code, signal: undefined })
		}
	}
}

console.log('the command')

await test('posix runs the login shell, and says nothing to it', async () => {
	// No command is the point: ssh then starts the account's own login shell, which
	// is what the operator would have got by typing ssh. Naming bash would be a
	// different terminal on a zsh machine.
	assert.equal(terminal.terminalCommand('posix'), undefined)
	const argv = terminal.terminalArgv(DEVICE, 'posix', 'ssh')
	assert.deepEqual(argv.slice(0, 3), ['ssh', '-tt', '-o'])
	assert.equal(argv.at(-1), 'deploy@10.0.0.2')
	assert.ok(argv.includes('-p'))
	assert.equal(argv[argv.indexOf('-p') + 1], '2222')
})

await test('windows prefers pwsh, falls back to powershell, and starts it interactively', async () => {
	const command = terminal.terminalCommand('windows')
	// The whole command is one argv element with no character any of the three
	// shells between here and the prompt would act on. That is the contract
	// `-EncodedCommand` exists for.
	assert.match(command, /^powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/u)
	const encoded = command.slice(command.lastIndexOf(' ') + 1)
	const script = Buffer.from(encoded, 'base64').toString('utf16le')
	assert.match(script, /Get-Command pwsh -CommandType Application/u)
	assert.match(script, /& \$shell\.Source -NoLogo/u)
	assert.match(script, /& powershell -NoLogo/u)
	// No `-NonInteractive` and no `-NoExit`: the inner shell has to be a real
	// interactive session, and `exit` has to end the pty rather than drop the
	// operator into a wrapper prompt.
	assert.doesNotMatch(command, /-NonInteractive/u)
	assert.doesNotMatch(command, /-NoExit/u)
	// The outer PowerShell must not load a profile: its only job is the selection.
	assert.match(command, /-NoProfile/u)
})

await test('the Windows command is the last argv element and nothing else is added', async () => {
	const argv = terminal.terminalArgv(DEVICE, 'windows', 'ssh')
	assert.equal(argv.at(-1), terminal.terminalCommand('windows'))
	assert.deepEqual(argv.slice(0, 2), ['ssh', '-tt'])
})

await test('an unknown shell family is refused by name', async () => {
	assert.throws(() => terminal.terminalCommand('plan9'), /plan9/u)
	assert.throws(() => terminal.terminalArgv(DEVICE, undefined, 'ssh'), /undefined/u)
})

console.log('the local presets')

/**
 * A resolver environment with both platform shapes in it.
 *
 * The Windows entries use the `<root>` placeholder rather than a drive letter
 * because the repository's own guard refuses a path that only exists on the machine
 * that wrote it, and a fixture has no business naming one. The resolver is asked
 * about a platform that is not necessarily the one this suite runs on, which is the
 * point: it must use that platform's separators and `PATHEXT`, not the host's.
 */
const LOCAL_ENV = {
	PATH: '<root>',
	PATHEXT: '.COM;.EXE;.BAT;.CMD',
	SystemRoot: '<root>\\Windows',
	ComSpec: '<root>\\Windows\\System32\\cmd.exe',
	SHELL: '/bin/zsh'
}

/**
 * An `exists` predicate that answers true for the given paths.
 * @param paths - the paths that exist.
 * @returns the predicate.
 */
function existing(...paths) {
	return (candidate) => paths.includes(candidate)
}

await test('a Windows shell prefers pwsh, then powershell, and is rooted in PATH', async () => {
	const pwsh = terminal.localCommand('shell', {
		platform: 'win32',
		env: LOCAL_ENV,
		exists: existing('<root>\\pwsh.exe', '<root>\\powershell.exe')
	})
	assert.deepEqual(pwsh, { file: '<root>\\pwsh.exe', args: ['-NoLogo'] })

	const fallback = terminal.localCommand('shell', {
		platform: 'win32',
		env: LOCAL_ENV,
		exists: existing('<root>\\powershell.exe')
	})
	assert.equal(fallback.file, '<root>\\powershell.exe')
	// ConPTY does not search PATH, so the answer has to be the full path it was
	// found at — a bare `powershell` is a tab that fails to spawn.
	assert.ok(fallback.file.startsWith('<root>\\'), 'the answer was not rooted in the PATH entry')
})

await test('a POSIX shell is $SHELL, then sh, and never a forced login', async () => {
	const zsh = terminal.localCommand('shell', {
		platform: 'linux',
		env: { ...LOCAL_ENV, PATH: '/usr/local/bin:/usr/bin' },
		exists: existing('/bin/zsh')
	})
	assert.deepEqual(zsh, { file: '/bin/zsh', args: [] })

	// `$SHELL` can name a shell someone uninstalled. The fallback is `sh`, not a tab
	// that cannot start.
	const sh = terminal.localCommand('shell', {
		platform: 'linux',
		env: { PATH: '/usr/bin', SHELL: '/gone/zsh' },
		exists: existing('/usr/bin/sh')
	})
	assert.deepEqual(sh, { file: '/usr/bin/sh', args: [] })
})

await test('a Windows agent is started through cmd, because a .cmd is not an executable', async () => {
	const command = terminal.localCommand('pi', {
		platform: 'win32',
		env: LOCAL_ENV,
		exists: existing('<root>\\pi.cmd', '<root>\\Windows\\System32\\cmd.exe')
	})
	assert.equal(command.file, '<root>\\Windows\\System32\\cmd.exe')
	assert.deepEqual(command.args, ['/d', '/s', '/c', '<root>\\pi.cmd'])

	// An .exe needs no interpreter; wrapping it would put cmd between the tab and
	// the agent for no reason.
	const exe = terminal.localCommand('opencode', {
		platform: 'win32',
		env: LOCAL_ENV,
		exists: existing('<root>\\opencode.exe')
	})
	assert.deepEqual(exe, { file: '<root>\\opencode.exe', args: [] })
})

await test('a POSIX agent is spawned directly, and a missing one is named', async () => {
	const command = terminal.localCommand('pi', {
		platform: 'linux',
		env: { PATH: '/opt/bin' },
		exists: existing('/opt/bin/pi')
	})
	assert.deepEqual(command, { file: '/opt/bin/pi', args: [] })

	assert.throws(
		() => terminal.localCommand('opencode', { platform: 'linux', env: { PATH: '/opt/bin' }, exists: () => false }),
		/opencode was not found on PATH/u
	)
	assert.throws(() => terminal.localCommand('vim', { platform: 'linux', env: {} }), /unknown local terminal preset "vim"/u)
})

await test('the preset list marks what cannot be started, with the reason', async () => {
	const presets = terminal.listPresets({
		platform: 'win32',
		env: LOCAL_ENV,
		exists: existing('<root>\\pwsh.exe', '<root>\\Windows\\System32\\cmd.exe')
	})
	assert.deepEqual(
		presets.map((entry) => [entry.id, entry.available]),
		[
			['shell', true],
			['pi', false],
			['opencode', false]
		]
	)
	// A disabled button is only useful if its tooltip says what to fix.
	assert.match(presets[1].reason, /pi was not found on PATH/u)
})

console.log('the session')

/**
 * Start one session against a fake pty.
 * @param overrides - start options to override.
 * @returns the pty, the calls the session made, and what it delivered.
 */
function started(overrides = {}) {
	const pty = fakePty()
	const calls = []
	const received = []
	const exits = []
	const session = terminal.start({
		device: DEVICE,
		platform: 'posix',
		ssh: 'ssh',
		cols: 90,
		rows: 30,
		spawn: (file, args, options) => {
			calls.push({ file, args, options })
			return pty
		},
		onData: (data) => received.push(data),
		onExit: (status) => exits.push(status),
		...overrides
	})
	return { pty, calls, received, exits, session }
}

await test('the pty is spawned with the argv, size and a TERM the far side can use', async () => {
	const { calls } = started()
	assert.equal(calls.length, 1)
	const [call] = calls
	assert.equal(call.file, 'ssh')
	assert.deepEqual(['ssh', ...call.args], terminal.terminalArgv(DEVICE, 'posix', 'ssh'))
	assert.equal(call.options.cols, 90)
	assert.equal(call.options.rows, 30)
	assert.equal(call.options.name, 'xterm-256color')
	// The Electron main process has no TERM of its own, and ssh sends whatever it
	// finds. Without this the far side gets no terminal type at all, and `ls` and
	// `vim` pick their dumb paths.
	assert.equal(call.options.env.TERM, 'xterm-256color')
})

await test('a password device authenticates through the askpass environment, not the argv', () => {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-tabs-terminal-askpass-'))
	try {
		const device = { ...DEVICE, auth: 'password' }
		const { calls } = started({ device, password: 'p@ss word', askpassDir: dir })
		const [call] = calls
		// The key block's `BatchMode=yes` would forbid the prompt the helper answers.
		assert.equal(call.args.includes('BatchMode=yes'), false, 'the password block still forbids the prompt')
		assert.ok(call.args.includes('PreferredAuthentications=password,keyboard-interactive'))
		assert.equal(call.options.env.DSH_SSH_PASSWORD, 'p@ss word')
		assert.equal(call.options.env.SSH_ASKPASS_REQUIRE, 'force')
		// The password is in the environment, never in the process command line.
		assert.equal(call.args.join(' ').includes('p@ss word'), false, 'the password reached ssh argv')
		// The askpass variables are merged into the environment, not substituted for
		// it: TERM is what makes the far side draw a terminal.
		assert.equal(call.options.env.TERM, 'xterm-256color')
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

await test('a local session is spawned with its preset, directory and size', async () => {
	const pty = fakePty()
	const calls = []
	const received = []
	const session = terminal.startLocal({
		preset: 'shell',
		platform: 'win32',
		env: LOCAL_ENV,
		exists: existing('<root>\\pwsh.exe'),
		cwd: '<root>\\box',
		cols: 88,
		rows: 22,
		spawn: (file, args, options) => {
			calls.push({ file, args, options })
			return pty
		},
		onData: (data) => received.push(data)
	})
	assert.equal(calls.length, 1)
	const [call] = calls
	assert.equal(call.file, '<root>\\pwsh.exe')
	assert.deepEqual(call.args, ['-NoLogo'])
	// The directory reaches the pty as an option, not as a `cd` typed into a shell:
	// that is what makes "pi starts in this project" true for the program's whole
	// lifetime, including its first prompt.
	assert.equal(call.options.cwd, '<root>\\box')
	assert.equal(call.options.cols, 88)
	assert.equal(call.options.rows, 22)

	// The same hold-until-attach rule as a remote terminal: the first thing a failing
	// program prints is the reason, and it prints it before the renderer has a screen.
	pty.emit('PS> ')
	assert.deepEqual(received, [], 'the local session drew before there was a screen')
	session.attach()
	assert.deepEqual(received, ['PS> '])
})

await test('a local preset that is missing fails before any pty is spawned', async () => {
	let spawned = 0
	assert.throws(
		() =>
			terminal.startLocal({
				preset: 'pi',
				platform: 'linux',
				env: { PATH: '/opt/bin' },
				exists: () => false,
				spawn: () => {
					spawned += 1
					return fakePty()
				}
			}),
		/pi was not found on PATH/u
	)
	assert.equal(spawned, 0, 'a pty was spawned for a preset that could not be resolved')
})

await test('output is held until attach, then released once and in order', async () => {
	const { pty, received, session } = started()
	pty.emit('box-a$ ')
	pty.emit('ls\r\n')
	assert.deepEqual(received, [], 'the session drew before there was a screen')
	session.attach()
	assert.deepEqual(received, ['box-a$ ', 'ls\r\n'])
	// A second attach must not duplicate the prompt, or every reconnect would print
	// its first line twice.
	session.attach()
	assert.deepEqual(received, ['box-a$ ', 'ls\r\n'])
	pty.emit('after')
	assert.deepEqual(received, ['box-a$ ', 'ls\r\n', 'after'])
})

await test('input and resize reach the pty, and both are clamped', async () => {
	const { pty, session } = started()
	session.write('echo hi\r')
	session.resize(120, 40)
	assert.deepEqual(pty.writes, ['echo hi\r'])
	assert.deepEqual(pty.resizes, [[120, 40]])
	// A renderer bug or a crafted IPC message cannot ask a pty for a window larger
	// than anything that will ever be drawn.
	session.resize(100000, 100000)
	session.resize(0, -1)
	assert.deepEqual(pty.resizes.slice(1), [
		[terminal.MAX_COLS, terminal.MAX_ROWS],
		[2, 1]
	])
	// Nothing that is not a string reaches the pty.
	session.write(undefined)
	session.write('')
	assert.deepEqual(pty.writes, ['echo hi\r'])
})

await test('an exit is reported, and a dead session takes no more input', async () => {
	const { pty, session, exits } = started()
	assert.equal(session.stillRunning(), true)
	pty.exit(255)
	assert.deepEqual(exits, [{ exitCode: 255, signal: undefined }])
	assert.equal(session.stillRunning(), false)
	session.write('typed after death')
	session.resize(80, 24)
	assert.deepEqual(pty.writes, [])
	assert.deepEqual(pty.resizes, [])
})

await test('kill reaches the pty once, and a throwing pty is one failed tab', async () => {
	const { pty, session } = started()
	session.kill()
	session.kill()
	assert.equal(pty.kills(), 1, 'the second kill reached an already-dead pty')
	// The module promises the throw reaches the caller, which is what turns it into
	// a failed tab with the native binding's own reason.
	assert.throws(
		() =>
			terminal.start({
				device: DEVICE,
				platform: 'posix',
				ssh: 'ssh',
				spawn: () => {
					throw new Error('node-pty is not built for this platform')
				}
			}),
		/node-pty is not built/u
	)
})

await test('a session holds at most its buffer, and the newest output survives', async () => {
	const { pty, received, session } = started()
	// A tab nobody has looked at yet, with a command that prints more than the cap.
	const chunk = 'x'.repeat(64 * 1024)
	for (let index = 0; index < 12; index += 1) pty.emit(chunk)
	session.attach()
	const total = received.reduce((sum, data) => sum + data.length, 0)
	assert.ok(total <= terminal.MAX_PENDING, `held ${String(total)} characters, cap is ${String(terminal.MAX_PENDING)}`)
	assert.ok(total > 0, 'the buffer dropped everything')
	// The tail is what a reader needs: a failure's last line is its reason.
	assert.ok(received.at(-1).endsWith('x'), 'the newest output was dropped instead of the oldest')
})

console.log(`\n${String(passes)} checks passed${failures.length === 0 ? '' : `, ${String(failures.length)} failed`}`)
if (failures.length > 0) process.exitCode = 1
