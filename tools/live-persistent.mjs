/**
 * Drive the persistent-host path against a real device, with no window anywhere.
 *
 * The suite proves the *semantics* (adopt, detach, reconnect, stop) against a
 * stubbed connect module, and `docs/contract.json` pins the *strings*. Neither can
 * prove the thing the mode is named for: that a real Harness on a real machine
 * survives the connection that started it, and that the next connection adopts
 * that same process. This file does, over the same `src/connect.js` the
 * application uses.
 *
 * It is deliberately not part of `npm test`: it needs a device that is up, an ssh
 * key that works, and a `dsh` on the far side's PATH — and it starts and stops a
 * process there.
 *
 * The far side's DSH home defaults to a scratch directory (`/tmp/dsh-tabs-live` by
 * default, `%TEMP%\dsh-tabs-live` on Windows) so the device's own Sessions are not
 * touched. Pass `--home <path>` to use a different one, and `--keep` to leave the
 * home and the host behind.
 *
 * Usage: node tools/live-persistent.mjs <device-id|label> [--home <path>] [--keep]
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

const args = process.argv.slice(2)
const wanted = args.find((value) => !value.startsWith('--'))
const homeFlag = args.indexOf('--home')
const keep = args.includes('--keep')

const book = await devices.load()
const device = wanted === undefined ? book[0] : book.find((entry) => entry.id === wanted || entry.label === wanted)
if (device === undefined) {
	console.error(book.length === 0 ? 'the device book is empty' : `no device matches ${String(wanted)}`)
	process.exit(2)
}

// The scratch home is a path on the **far side**, so it follows the device's shell
// family rather than this machine's. A Windows remote has no `$TEMP` we can expand
// from here, so it is asked for explicitly rather than guessed.
const farWindows = device.platform === 'windows'
if (homeFlag === -1 && farWindows) {
	console.error('this device is Windows: pass --home <a path on that machine>')
	process.exit(2)
}
const scratch = farWindows ? undefined : '/tmp/dsh-tabs-live'
const home = homeFlag === -1 ? scratch : args[homeFlag + 1]
if (home === undefined) {
	console.error('--home needs a path')
	process.exit(2)
}

// The book is read as-is, without `normalize`, so the derived port has to be applied
// here too — and it is the point of the run: both connections must use the same one.
const target = { ...device, mode: 'persistent', home, localPort: device.localPort ?? devices.deriveLocalPort(device.id) }
console.log(`device: ${device.label} (${device.user}@${device.host}:${String(device.sshPort)})`)
console.log(`home:   ${home}`)

/** Lines the connect path printed, for the report. */
const lines = []
const onLine = (text) => {
	lines.push(text)
	console.log(`  | ${text}`)
}

let failures = 0
/**
 * One assertion, counted.
 * @param name - what is being asserted.
 * @param ok - the result.
 * @param detail - why it failed, when it did.
 */
function check(name, ok, detail = '') {
	if (ok) {
		console.log(`  ok  ${name}`)
		return
	}
	failures += 1
	console.error(`FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

console.log('\n1. first connection: start or adopt, then tunnel')
const first = await connect.connectRemote(target, { onLine })
if (first.error !== undefined) {
	console.error(`FAIL  the connect failed: ${first.error}`)
	process.exit(1)
}
check('a URL was announced', typeof first.url === 'string' && first.url.startsWith('http://127.0.0.1:'), first.url)
check('the connection is a persistent one', first.persistent === true)
check('the local port is the record’s stable one', first.localPort === target.localPort, `${String(first.localPort)} != ${String(target.localPort)}`)
const firstToken = new URL(first.url).searchParams.get('token')
console.log(`     url ${first.url.replace(/token=[^&]*/u, 'token=<hidden>')} remotePort=${String(first.remotePort)}`)

console.log('\n2. let go of the tunnel without stopping the host')
first.detach()
await new Promise((resolve) => setTimeout(resolve, 1_500))

console.log('\n3. second connection: it must adopt the process the first one left')
const second = await connect.connectRemote(target, { onLine })
if (second.error !== undefined) {
	console.error(`FAIL  the second connect failed: ${second.error}`)
	process.exit(1)
}
check('the host was adopted, not started again', second.adopted === true)
check('the same remote process is behind it', second.remotePort === first.remotePort, `${String(first.remotePort)} -> ${String(second.remotePort)}`)
check('the same launch token is behind it', new URL(second.url).searchParams.get('token') === firstToken)
// The origin, not the process: this is what makes the browser cookie and the page's own
// "last Session" survive the reconnect, and it is lost the moment the port moves.
check('the same local port — the same origin — was used', second.localPort === first.localPort, `${String(first.localPort)} -> ${String(second.localPort)}`)

console.log('\n4. stop the host explicitly')
const stopped = await second.terminate()
const said = stopped.join(' ')
check('the stop program named a pid', /HOST stopped pid=\d+/u.test(said), said)

if (!keep && home === scratch) {
	console.log('\n5. leave the far side as it was found')
	// The scratch home holds the profile the first connect created. The record, the log
	// and the lock are already gone with the host; removing the directory is the only
	// cleanup left, and only ever for the default scratch path — a `--home` the operator
	// named is theirs to keep.
	await sshRun(`rm -rf ${remote.shellSingleQuote(home)}`)
}

console.log(`\n${failures === 0 ? 'PASS' : `${String(failures)} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

/**
 * Run one remote command and collect what it prints, without waiting for ever.
 *
 * A login profile that leaves a background process holding the session's stdout makes
 * the ssh client stay open after the command has finished — measured on a real Linux
 * remote, where even `ssh host 'echo hi'` never returned. The work is done when the
 * first byte of output is the command's own, so this bounds the wait and kills the
 * client rather than trusting the channel to close.
 * @param command - the remote command argument.
 * @returns the collected output.
 */
function sshRun(command) {
	return new Promise((resolve) => {
		const child = spawn(connect.sshExecutable(), [...remote.sshOptions(device), `${device.user}@${device.host}`, command], {
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		})
		let out = ''
		child.stdout?.setEncoding('utf8')
		child.stderr?.setEncoding('utf8')
		child.stdout?.on('data', (chunk) => {
			out += chunk
		})
		child.stderr?.on('data', (chunk) => {
			out += chunk
		})
		const timer = setTimeout(() => {
			try {
				child.kill()
			} catch {
				/* already gone */
			}
			resolve(out)
		}, 10_000)
		child.once('exit', () => {
			clearTimeout(timer)
			resolve(out)
		})
		child.once('error', () => {
			clearTimeout(timer)
			resolve(out)
		})
	})
}
