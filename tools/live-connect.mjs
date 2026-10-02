/**
 * Drive the real connect path against a real device, with no window anywhere.
 *
 * This exists because the riskiest code in dsh-tabs — two ssh connections, a
 * readiness line, an asynchronously-binding tunnel, and a teardown contract
 * whose failure mode is an orphaned server on someone else's machine — must not
 * be reachable only by launching a GUI. `src/connect.js` has no Electron
 * dependency precisely so this file can exist.
 *
 * It reads the device book and never writes to it.
 *
 * Usage: node tools/live-connect.mjs [device-id]
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const require = createRequire(import.meta.url)
const connect = require(join(ROOT, 'src', 'connect.js'))
const devices = require(join(ROOT, 'src', 'devices.js'))
const remote = require(join(ROOT, 'src', 'remote.js'))

const wanted = process.argv[2]
const book = await devices.load()
const device = wanted === undefined ? book[0] : book.find((entry) => entry.id === wanted || entry.label === wanted)
if (device === undefined) {
	console.error(book.length === 0 ? 'the device book is empty' : `no device matches ${String(wanted)}`)
	process.exit(2)
}

console.log(`device: ${device.label} (${device.user}@${device.host}:${String(device.sshPort)})`)

/**
 * Run one remote command over ssh and collect everything it prints.
 * @param command - the remote command argument.
 * @returns the exit code and the two streams.
 */
function sshRun(command) {
	return new Promise((resolve) => {
		const child = spawn(connect.sshExecutable(), [...remote.sshOptions(device), `${device.user}@${device.host}`, command], {
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		})
		let out = ''
		let err = ''
		child.stdout.setEncoding('utf8')
		child.stderr.setEncoding('utf8')
		child.stdout.on('data', (chunk) => {
			out += chunk
		})
		child.stderr.on('data', (chunk) => {
			err += chunk
		})
		child.once('exit', (code) => {
			resolve({ code: code ?? 0, out, err })
		})
		child.once('error', (error) => {
			resolve({ code: 255, out, err: error.message })
		})
	})
}

/**
 * The set of Harness servers currently running on the far side.
 *
 * The bracket in the pattern is load-bearing: a plain `pgrep -f 'dsh web'` run
 * over ssh matches its own command line, and an earlier version of this check
 * reported a phantom orphan for exactly that reason.
 *
 * @returns a sorted list of matching process lines.
 */
async function remoteServers() {
	const result = await sshRun("pgrep -af 'dsh web --no-open --port [0]' | sort || true")
	return result.out.trim().split('\n').filter((line) => line.trim() !== '')
}

let failures = 0
let passes = 0

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
		failures += 1
		console.error(`FAIL  ${name}`)
		console.error(`      ${error instanceof Error ? error.message : String(error)}`)
	}
}

/**
 * Assert a condition.
 * @param value - the condition.
 * @param message - the failure message.
 */
function ok(value, message) {
	if (!value) throw new Error(message)
}

const before = await remoteServers()
console.log(`servers on the far side before: ${String(before.length)}`)

const lines = []
const connection = await connect.connectRemote(device, {
	onLine: (line) => {
		lines.push(line)
		console.log(`      | ${line}`)
	}
})

if (connection.error !== undefined) {
	console.error(`\nconnect failed: ${connection.error}`)
	console.error(lines.join('\n'))
	process.exit(1)
}

console.log(`\nconnected: ${connection.url.replace(/token=[^&]*/u, 'token=<hidden>')}\n`)

await test('the readiness URL is a loopback URL on a real port', () => {
	const parsed = new URL(connection.url)
	ok(parsed.hostname === '127.0.0.1', `hostname is ${parsed.hostname}`)
	ok(Number(parsed.port) > 0, 'no port')
	ok(connection.remotePort !== connection.localPort, 'the tunnel reused the remote port')
})

await test('the tunnel accepts a connection', async () => {
	ok(await connect.waitForLocalPort(connection.localPort, 5000), 'nothing listening on the forwarded port')
})

// A browser follows the token redirect and stores the cookie without being
// asked. Node's fetch keeps no cookie jar, so this test does explicitly what the
// `<webview>` will do implicitly — and in doing so it checks the exchange itself.
const origin = `http://127.0.0.1:${String(connection.localPort)}`
let cookie = ''

await test('the token URL hands out the session cookie', async () => {
	const response = await fetch(connection.url, { redirect: 'manual' })
	ok(response.status === 303, `expected a 303 redirect, got HTTP ${String(response.status)}`)
	const issued = response.headers.get('set-cookie') ?? ''
	ok(issued !== '', 'no Set-Cookie on the token exchange')
	ok(/HttpOnly/iu.test(issued), 'the session cookie is not HttpOnly')
	ok(!/Secure/iu.test(issued), 'a Secure cookie would never be sent back over plain loopback http')
	cookie = issued.split(';')[0]
})

await test('the tunneled interface serves the Harness document', async () => {
	const response = await fetch(`${origin}/`, { headers: { cookie } })
	ok(response.status === 200, `HTTP ${String(response.status)}`)
	const body = await response.text()
	ok(body.includes('__DSH_BOOT__'), 'the response is not a Harness document')
})

await test('the fence still holds through the tunnel', async () => {
	// The tunnel must not launder an unauthenticated request into one the far side
	// accepts; if this ever returns 200 the forward is bypassing the Host's guard.
	const response = await fetch(`${origin}/api/agentPresets/list`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ type: 'client-request', rpcId: 'live-0', method: 'agentPresets/list', payload: { args: {} } })
	})
	ok(response.status === 401, `an unauthenticated call returned HTTP ${String(response.status)}`)
})

await test('the forwarded origin answers the unary RPC carrier', async () => {
	// The carrier is `/api/<endpoint>` with the method in the body; posting to
	// `/api` itself is a 404 that says nothing about the tunnel.
	const response = await fetch(`${origin}/api/agentPresets/list`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie },
		body: JSON.stringify({ type: 'client-request', rpcId: 'live-1', method: 'agentPresets/list', payload: { args: {} } })
	})
	ok(response.status === 200, `HTTP ${String(response.status)}`)
	const payload = await response.json()
	ok(payload.type === 'server-response', `unexpected payload ${JSON.stringify(payload).slice(0, 120)}`)
})

await test('stopping honours the teardown contract', async () => {
	connection.stop()
	// The remote server is reaped by sshd when the connection's stdin reaches EOF,
	// which is asynchronous; give it a moment before judging.
	const deadline = Date.now() + 15_000
	while (Date.now() < deadline) {
		const now = await remoteServers()
		if (now.length <= before.length) return
		await new Promise((resolve) => setTimeout(resolve, 700))
	}
	const after = await remoteServers()
	throw new Error(`the far side still has ${String(after.length)} servers, was ${String(before.length)}:\n${after.join('\n')}`)
})

await test('the forwarded port stops answering', async () => {
	const alive = await connect.waitForLocalPort(connection.localPort, 1500)
	ok(!alive, 'the tunnel port still accepts connections after stop()')
})

console.log(`\n${String(passes)} checks passed${failures === 0 ? '' : `, ${String(failures)} failed`}`)
if (failures > 0) process.exitCode = 1
