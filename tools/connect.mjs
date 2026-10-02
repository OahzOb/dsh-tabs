/**
 * Offline checks for the parts of `src/connect.js` that do not need a remote.
 *
 * `tools/live-connect.mjs` proves the whole path against a real machine, but it
 * needs a reachable device and it is slow. These are the pieces underneath it —
 * port allocation, the tunnel readiness probe, and the readiness-line reader —
 * and each of them has a failure mode worth pinning down without a network.
 *
 * Usage: node tools/connect.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const require = createRequire(import.meta.url)
const connect = require(join(ROOT, 'src', 'connect.js'))
const localdsh = require(join(ROOT, 'src', 'localdsh.js'))

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

/**
 * A stand-in for a spawned server process.
 * @returns a fake child with piped output.
 */
function fakeChild() {
	const child = new EventEmitter()
	child.stdout = new PassThrough()
	child.stderr = new PassThrough()
	child.exitCode = null
	child.killed = false
	child.kill = () => {
		child.killed = true
	}
	child.stdin = {
		ended: false,
		end() {
			this.ended = true
		}
	}
	return child
}

console.log('port allocation')

await test('an allocated port is real and bindable', async () => {
	// `--port 0` on the far side plus a locally chosen forward is the whole reason a
	// connect cannot collide with anything; if freePort handed back a dud, the
	// tunnel would fail with a confusing bind error instead.
	const port = await connect.freePort()
	assert.ok(Number.isInteger(port) && port > 0)
	await new Promise((resolve, reject) => {
		const server = createServer()
		server.once('error', reject)
		server.listen(port, '127.0.0.1', () => {
			server.close(resolve)
		})
	})
})

await test('two allocations do not hand back the same port', async () => {
	const first = await connect.freePort()
	const second = await connect.freePort()
	assert.notEqual(first, second)
})

console.log('tunnel readiness')

await test('a listening port is detected', async () => {
	const server = createServer()
	await new Promise((resolve) => {
		server.listen(0, '127.0.0.1', resolve)
	})
	const port = server.address().port
	try {
		assert.equal(await connect.waitForLocalPort(port, 2000), true)
	} finally {
		server.close()
	}
})

await test('a port with nothing behind it gives up instead of hanging', async () => {
	// `ssh -L` binds asynchronously. Navigating a guest before the forward is live
	// shows a connection-refused error page that reads as a broken device, so the
	// probe has to answer "not yet" and the caller has to treat that as fatal.
	const port = await connect.freePort()
	const started = Date.now()
	assert.equal(await connect.waitForLocalPort(port, 400), false)
	assert.ok(Date.now() - started < 4000, 'the probe did not respect its deadline')
})

console.log('the readiness line')

await test('the URL is found when it arrives in one chunk', async () => {
	const child = fakeChild()
	const lines = []
	const pending = connect.awaitReady(child, (line) => lines.push(line), 2000)
	child.stdout.write('dsh web: http://127.0.0.1:42341/?token=abc\n')
	const result = await pending
	assert.equal(result.url, 'http://127.0.0.1:42341/?token=abc')
	assert.ok(lines.some((line) => line.includes('42341')))
})

await test('the URL is found when it is split across chunks', async () => {
	// The reader accumulates raw output rather than matching line by line. A stdout
	// pipe hands over whatever the writer flushed, so a URL can arrive in pieces —
	// and a line-oriented matcher would wait forever on a line that already passed.
	const child = fakeChild()
	const pending = connect.awaitReady(child, () => {}, 2000)
	child.stdout.write('dsh web: http://127.0.0.')
	child.stdout.write('1:42341/?tok')
	child.stdout.write('en=abc\n')
	const result = await pending
	assert.equal(result.url, 'http://127.0.0.1:42341/?token=abc')
})

await test('a partial URL is never accepted, however it is chunked', async () => {
	// The regression this suite found: the pattern ends in `\S+`, so matching the
	// raw buffer resolved with `http://127.0.0.` and a port of NaN. Whether a
	// connect worked came down to how the OS chunked the pipe.
	assert.equal(connect.readyUrl('dsh web: http://127.0.0.'), null)
	assert.equal(connect.readyUrl('dsh web: http://127.0.0.1:4234'), null)
	assert.equal(connect.readyUrl('dsh web: http://127.0.0.1:42341/?token=abc'), null)
	assert.equal(connect.readyUrl('dsh web: http://127.0.0.1:42341/?token=abc\n'), 'http://127.0.0.1:42341/?token=abc')
	// Once the process has stopped printing, an unterminated trailing line is as
	// complete as it will ever be.
	assert.equal(connect.readyUrl('dsh web: http://127.0.0.1:42341/?token=abc', true), 'http://127.0.0.1:42341/?token=abc')
})

await test('the URL after the split one is the one that wins', async () => {
	// Two lines: a truncated-looking one that is genuinely complete, then the real
	// one. The first complete line must win, exactly as the far side printed it.
	const child = fakeChild()
	const pending = connect.awaitReady(child, () => {}, 2000)
	child.stdout.write('dsh web: http://127.0.0.1:1/?token=first\n')
	child.stdout.write('dsh web: http://127.0.0.1:2/?token=second\n')
	const result = await pending
	assert.equal(result.url, 'http://127.0.0.1:1/?token=first')
})

await test('stderr is recorded, not ignored', async () => {
	// A connect that fails usually says why on stderr. A reader watching only
	// stdout reports a timeout with an empty transcript, which is the least
	// actionable failure this app can produce.
	const child = fakeChild()
	const lines = []
	const pending = connect.awaitReady(child, (line) => lines.push(line), 2000)
	child.stderr.write('bash: dsh: command not found\n')
	child.stdout.write('dsh web: http://127.0.0.1:1/?token=t\n')
	await pending
	assert.ok(lines.some((line) => line.startsWith('! ') && line.includes('command not found')))
})

await test('a process that exits first reports its exit code', async () => {
	const child = fakeChild()
	const pending = connect.awaitReady(child, () => {}, 2000)
	child.exitCode = 127
	child.emit('exit', 127)
	const result = await pending
	assert.match(result.error, /exited with code 127/u)
	assert.equal(result.url, undefined)
})

await test('a process that exits says what the far side said, not just its code', async () => {
	// Measured against a real Windows host: the remote printed the sentence that
	// named the fault and the client reported only "exited with code 1", so the
	// operator had to go and find out why. The transcript did have it; the message
	// did not.
	const child = fakeChild()
	const pending = connect.awaitReady(child, () => {}, 2000)
	child.stderr.write("bash: line 1: cd: /nope: No such file or directory\n")
	child.emit('exit', 1)
	const result = await pending
	assert.match(result.error, /exited with code 1/u)
	assert.match(result.error, /No such file or directory/u, 'the reason was dropped')
})

await test('PowerShell CLIXML is decoded rather than pasted in', async () => {
	// PowerShell serialises its error stream as CLIXML whenever stderr is redirected,
	// so a Windows remote that fails sends one `<Objs …>` document. This is the real
	// shape, copied from box-b: 1131 bytes over two lines, with the sentence that
	// matters inside an `<S S="Error">` record and its newlines escaped.
	const clixml =
		'#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
		'<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Object</T></TN>' +
		'<MS><AV>Preparing modules for first use.</AV></MS></Obj>' +
		'<S S="Error">Set-Location : Cannot find path \'C:\\nope\' because it does not exist._x000D__x000A_</S>' +
		'<S S="Error">At line:1 char:1108_x000D__x000A_</S>' +
		'<S S="Error">+ ... ; Set-Location -LiteralPath $dir -ErrorAction Stop; $argv  ..._x000D__x000A_</S>' +
		'</Objs>'
	const said = connect.readableStderr(clixml)
	assert.match(said, /Cannot find path/u, 'the error record was not recovered')
	assert.match(said, /does not exist/u, 'the sentence was truncated')
	// The follow-up records are PowerShell's source excerpt and its `CategoryInfo`.
	// They are for whoever edits the script, not for whoever is trying to connect, so
	// the message keeps only the first record.
	assert.ok(!said.includes('At line:1'), 'the source excerpt was pasted into the message')
	assert.ok(!said.includes('CategoryInfo'), 'the error category was pasted into the message')
	assert.ok(!said.includes('<Objs'), 'the CLIXML envelope leaked into the message')
	assert.ok(!said.includes('_x000D_'), 'the escapes were not decoded')
	assert.ok(!said.includes('\n'), 'the message is not one line')
	// The progress record is not an error and must not be quoted as one.
	assert.ok(!said.includes('Preparing modules'), 'a progress record was reported as an error')
})

await test('ordinary stderr is passed through, and a huge one is bounded', async () => {
	// A POSIX shell's stderr is already what a reader wants, so it must not be mangled.
	assert.equal(connect.readableStderr('bash: dsh: command not found\n'), 'bash: dsh: command not found')
	assert.equal(connect.readableStderr(''), '')
	assert.equal(connect.readableStderr(undefined), '')
	// And a wall of text must not become the whole failure panel.
	const long = connect.readableStderr(`x`.repeat(2000))
	assert.ok(long.length <= 301, `the message was not bounded: ${String(long.length)} chars`)
	assert.ok(long.endsWith('…'), 'the truncation is not visible')
})

await test('a spawn that never produces anything times out with a reason', async () => {
	const child = fakeChild()
	const result = await connect.awaitReady(child, () => {}, 60)
	assert.match(result.error, /never announced a URL/u)
	assert.match(result.error, /0s|1s/u)
})

console.log('the local dsh version')

await test('a version is read out of whatever the command printed', () => {
	// The shape this application has measured: `dsh --version` answers `0.2.0-rc.2\n`
	// and nothing else. The rest of these are the cases that make a parser worth
	// having rather than a `Number()` call.
	assert.equal(localdsh.parseVersion('0.2.0-rc.2\n'), '0.2.0-rc.2')
	assert.equal(localdsh.parseVersion('0.2.0'), '0.2.0')
	assert.equal(localdsh.parseVersion('  0.10.0  \r\n'), '0.10.0')
	assert.equal(localdsh.parseVersion('1.2.3+build.5\n'), '1.2.3')
	// A banner above the version must not defeat it.
	assert.equal(localdsh.parseVersion('dsh 0.2.0-rc.2\nready\n'), '0.2.0-rc.2')
	// And nothing at all must be reported as nothing, not guessed at.
	assert.equal(localdsh.parseVersion(''), null)
	assert.equal(localdsh.parseVersion('dsh: command not found\n'), null)
	assert.equal(localdsh.parseVersion(undefined), null)
})

await test('versions compare the way semver says they do', () => {
	// Numeric parts compare as numbers, which is the one a string comparison gets
	// wrong and the one that would silently pass a too-old version.
	assert.ok(localdsh.compareVersions('0.10.0', '0.9.0') > 0, '0.10.0 must beat 0.9.0')
	assert.ok(localdsh.compareVersions('0.2.0', '0.10.0') < 0)
	// A pre-release is older than the release it leads to.
	assert.ok(localdsh.compareVersions('0.2.0-rc.2', '0.2.0') < 0)
	assert.ok(localdsh.compareVersions('0.2.0', '0.2.0-rc.2') > 0)
	// Pre-release identifiers compare in order, numerically where they are numbers.
	assert.ok(localdsh.compareVersions('0.2.0-rc.2', '0.2.0-rc.10') < 0, 'rc.2 must be older than rc.10')
	assert.ok(localdsh.compareVersions('0.2.0-rc.2', '0.2.0-rc.2') === 0)
	assert.ok(localdsh.compareVersions('0.2.0-beta', '0.2.0-rc.1') < 0, 'beta before rc')
	// Build metadata is ignored, as the specification says.
	assert.equal(localdsh.compareVersions('0.2.0+x', '0.2.0+y'), 0)
})

await test('the two versions that decided this floor are on the right sides of it', () => {
	// The pair the README records: `0.1.7-rc.2` fails the first turn with a message
	// about credentials, and `0.2.0-rc.2` works. A floor that does not separate these
	// two would not have caught the failure that cost two days.
	assert.ok(
		localdsh.compareVersions('0.1.7-rc.2', localdsh.MINIMUM_VERSION) < 0,
		'the version known to fail must be below the floor'
	)
	assert.ok(localdsh.compareVersions(localdsh.MINIMUM_VERSION, localdsh.MINIMUM_VERSION) === 0)
	assert.ok(localdsh.compareVersions('0.2.0', localdsh.MINIMUM_VERSION) > 0)
})

await test('a missing version is a problem, and the message says how to fix it', () => {
	const missing = localdsh.versionProblem(null, 'dsh: command not found')
	assert.match(missing, /dsh/u)
	assert.match(missing, /npm install -g @deepseek-ai\/dsh@latest/u, 'the fix is not named')
	assert.match(missing, /command not found/u, 'what the probe said was dropped')
	// No output at all still produces a sentence rather than a dangling colon.
	const silent = localdsh.versionProblem(null, '')
	assert.match(silent, /npm install -g/u)
	assert.ok(!silent.includes('— it said:'), `an empty quote was printed: ${silent}`)
})

await test('a too-old version is a problem, and the message connects it to credentials', () => {
	const old = localdsh.versionProblem('0.1.7-rc.2', '0.1.7-rc.2\n')
	// The whole point: an operator who has just seen MISSING_CREDENTIAL has no reason
	// to suspect a version, so the message has to make that connection itself.
	assert.match(old, /0\.1\.7-rc\.2/u, 'the version found is not named')
	assert.match(old, /0\.2\.0-rc\.2/u, 'the version required is not named')
	assert.match(old, /credential/u, 'the misleading symptom is not mentioned')
	assert.match(old, /npm install -g @deepseek-ai\/dsh@latest/u, 'the fix is not named')
})

await test('a new enough version is not a problem, including the floor itself', () => {
	assert.equal(localdsh.versionProblem(localdsh.MINIMUM_VERSION, ''), null)
	assert.equal(localdsh.versionProblem('0.2.0', ''), null)
	assert.equal(localdsh.versionProblem('1.0.0', ''), null)
})

await test('the probe command asks the shell the Harness will actually be started with', () => {
	// POSIX needs `-i`: an nvm install puts its bin directory on PATH from
	// `~/.bashrc`, which a non-interactive shell never sources, so a probe without it
	// would report "not found" for a machine where the launch works.
	const posix = localdsh.versionArgv('linux')
	assert.equal(posix[0], 'bash')
	assert.ok(posix.includes('-lic'), 'the probe does not ask for an interactive login shell')
	assert.ok(posix[posix.length - 1].includes('command -v dsh'), 'a missing dsh is not distinguished from a shell error')
	// Windows needs `cmd /c`, because `dsh` is a `.cmd` shim Node cannot execute itself.
	const windows = localdsh.versionArgv('win32')
	assert.equal(windows[0], 'cmd.exe')
	assert.deepEqual(windows.slice(1), ['/c', 'dsh --version'])
})

await test('the version this machine actually has is found and accepted', async () => {
	// Not a mock: the real probe, against whatever `dsh` is on PATH here. A machine
	// without one gets the "not found" answer, which is a problem — and that is
	// correct, because the local tab cannot work there either.
	const result = await localdsh.probeLocalDsh(process.platform)
	if (result.version === null) {
		assert.ok(
			localdsh.versionProblem(null, result.output) !== null,
			'a missing version must be reported as a problem'
		)
		console.log('  (no dsh on PATH here; the missing case was checked instead)')
		return
	}
	assert.match(result.version, /^\d+\.\d+\.\d+/u)
	assert.equal(
		localdsh.versionProblem(result.version, result.output),
		null,
		`this machine's dsh (${result.version}) is below the floor the application requires`
	)
})

console.log(`\n${String(passes)} checks passed${failures.length === 0 ? '' : `, ${String(failures.length)} failed`}`)
if (failures.length > 0) process.exitCode = 1
