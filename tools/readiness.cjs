'use strict'

/**
 * Time and check the local readiness line, offline.
 *
 * This is not part of `npm test`, and that is deliberate: the suites are offline
 * by design, and this one starts a real `dsh web` and waits for it. What it does
 * is answer two questions that were previously answered by hand and then written
 * into the README as a bare number ("readiness line in 1.5 s"):
 *
 *   1. does the readiness line this application parses still appear, in the shape
 *      `READY_LINE` matches? A `dsh` that changes its output format breaks the
 *      local tab, every remote tab, the Desktop plugin and the planned Android
 *      client at once, and nothing offline can notice.
 *   2. how long does it take? `START_TIMEOUT_MS` is the budget it must fit in.
 *
 * Usage:
 *
 *   node tools/readiness.cjs                 # 3 timed runs
 *   node tools/readiness.cjs 5               # 5 timed runs
 *
 * Exit code is 1 if any run failed to produce a readiness line, so a failure is
 * visible to a shell without reading the table.
 */

const { spawn, spawnSync } = require('node:child_process')

const remote = require('../src/remote.js')

/** How many timed runs to make. */
const RUNS = Math.max(1, Number(process.argv[2] ?? 3) || 3)

/** One run's hard ceiling. Beyond this the run is a failure, not a slow sample. */
const CEILING_MS = remote.START_TIMEOUT_MS + 5_000

/**
 * Stop the process the application started, and everything under it.
 *
 * Order matters and it is **the reverse of the application's**, which is worth
 * stating because the first version of this probe got it wrong and leaked a
 * Harness holding a loopback port on one run in four.
 *
 * The application closes stdin first, because that EOF is what makes a POSIX-side
 * server reap *itself* — a deliberate contract, and on a remote host the only one
 * that works. On Windows it cannot rely on that, so it follows up with a tree
 * kill. Here the tree kill comes **first**, and the reason is this process's own
 * exit: `exitCode` is still `null` when stdin is closed, so the kill is issued
 * against a shell that may have already died of the EOF — and `taskkill /T` on a
 * dead pid kills nothing, leaving the `dsh` grandchild alive. Killing the tree
 * while the shell is definitely up avoids that window entirely.
 *
 * Closing stdin afterwards then measures the contract instead of racing it: if
 * the server were going to reap itself, it has already been given the chance, and
 * the caller reports whether the child had exited before it was killed.
 *
 * @param child - the shell process this probe spawned.
 * @returns how it was stopped.
 */
function reap(child) {
	try {
		child.stdin?.end()
	} catch {
		/* the pipe may already be gone */
	}
	const hadExited = child.exitCode !== null
	if (process.platform === 'win32' && child.pid !== undefined) {
		const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
		return hadExited ? 'exit on EOF (tree kill found nothing)' : killed.status === 0 ? 'taskkill /T /F' : 'kill (taskkill found nothing)'
	}
	try {
		child.kill()
	} catch {
		/* already gone */
	}
	return hadExited ? 'exit on EOF' : 'kill'
}

/**
 * Start one local Harness and stop it again.
 *
 * The launch is `remote.localDshArgv()`, not a hand-written `cmd /c` line, so the
 * thing being timed is the thing the application actually starts — including the
 * `.cmd` shim and the process tree that make the teardown non-trivial.
 *
 * @returns the elapsed milliseconds, the URL, and how the process was stopped.
 */
function once() {
	return new Promise((resolve) => {
		const argv = remote.localDshArgv()
		const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
		const started = Date.now()
		let out = ''
		let err = ''
		let done = false

		const finish = (result) => {
			if (done) return
			done = true
			clearTimeout(timer)
			resolve({ ...result, elapsed: Date.now() - started, err, reaped: reap(child) })
		}

		const timer = setTimeout(() => {
			finish({ url: null, why: `no readiness line within ${String(Math.round(CEILING_MS / 1000))}s` })
		}, CEILING_MS)

		const watch = (stream, sink) => {
			if (stream === null || stream === undefined) return
			stream.setEncoding('utf8')
			stream.on('data', (chunk) => {
				if (sink === 'out') out += chunk
				else err += chunk
				// The same reader the application uses, so what is checked is the
				// real parse and not a regex copied into this file.
				const url = remote.readyUrl(out)
				if (url !== null) finish({ url, why: null })
			})
		}
		watch(child.stdout, 'out')
		watch(child.stderr, 'err')

		child.once('error', (error) => {
			finish({ url: null, why: `could not start ${argv[0]}: ${error.message}` })
		})
		child.once('exit', (code) => {
			const url = remote.readyUrl(out, true)
			if (url !== null) finish({ url, why: null })
			else finish({ url: null, why: `exited with code ${String(code)} before announcing a URL` })
		})
	})
}

/**
 * Pause between runs.
 * @param ms - how long.
 * @returns a promise that settles afterwards.
 */
function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The loopback ports the Harnesses started here are listening on.
 *
 * Used as a leak detector, not as an assertion about the machine: the probe takes
 * a baseline before its first run and compares after each reap. The first version
 * of this file reaped in the wrong order and left one run's Harness listening —
 * on a port nothing in the output named, which is exactly the failure a probe of
 * this contract has to be able to see in itself.
 *
 * CIM rather than `netstat`, so the mapping from a listening port to *this* kind
 * of process is available.
 *
 * @returns a map of pid to the ports it holds.
 */
function listeningHarnesses() {
	const result = spawnSync('powershell', [
		'-NoProfile',
		'-NonInteractive',
		'-Command',
		[
			'$pids = @(Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -like \'*dsh*web*\' } | Select-Object -ExpandProperty ProcessId)',
			'foreach ($p in $pids) { foreach ($c in @(Get-NetTCPConnection -State Listen -OwningProcess $p -ErrorAction SilentlyContinue)) { "$p $($c.LocalPort)" } }'
		].join('; ')
	], { encoding: 'utf8', windowsHide: true })
	const map = new Map()
	for (const line of String(result.stdout ?? '').split(/\r?\n/u)) {
		const parts = line.trim().split(' ')
		if (parts.length !== 2) continue
		const pid = Number(parts[0])
		const port = Number(parts[1])
		if (!Number.isInteger(pid) || !Number.isInteger(port)) continue
		map.set(pid, port)
	}
	return map
}

async function main() {
	console.log(`local readiness: ${String(RUNS)} run(s), ceiling ${String(Math.round(CEILING_MS / 1000))}s, budget START_TIMEOUT_MS=${String(remote.START_TIMEOUT_MS)}ms`)
	console.log(`launch: ${remote.localDshArgv().join(' ')}`)
	console.log('')

	// Whatever was already listening belongs to somebody else — the operator's own
	// Harness, most likely — so only *new* listeners count as this probe's leak.
	const before = listeningHarnesses()
	const samples = []
	const leaks = []
	let failures = 0

	for (let index = 0; index < RUNS; index += 1) {
		const result = await once()
		if (result.url === null) {
			failures += 1
			console.log(`run ${String(index + 1)}: FAILED after ${(result.elapsed / 1000).toFixed(1)}s — ${result.why}`)
		} else {
			samples.push(result.elapsed)
			const parsed = remote.parseReadyUrl(result.url)
			console.log(
				`run ${String(index + 1)}: ${(result.elapsed / 1000).toFixed(1)}s  port=${String(parsed.port)}  token=${parsed.token === null ? 'none' : `${String(parsed.token.length)} chars`}  stopped by ${result.reaped}`
			)
		}
		const noise = result.err.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')
		if (noise.length > 0) console.log(`         stderr: ${noise[0].slice(0, 140)}${noise[0].length > 140 ? '…' : ''}`)

		// Give the tree kill a moment to be reaped by the OS before asking.
		await wait(400)
		for (const [pid, port] of listeningHarnesses()) {
			if (before.has(pid)) continue
			leaks.push({ run: index + 1, pid, port })
			console.log(`         LEAK: pid ${String(pid)} is still listening on 127.0.0.1:${String(port)} after run ${String(index + 1)}`)
		}
		if (index < RUNS - 1) await wait(1_000)
	}

	console.log('')
	if (leaks.length > 0) {
		console.log(`${String(leaks.length)} leaked Harness process(es) — the teardown above did not walk the whole tree.`)
		console.log('Kill them before leaving:  taskkill /PID <pid> /T /F')
	}
	if (failures > 0) {
		console.log(`${String(failures)} of ${String(RUNS)} run(s) failed to produce a readiness line.`)
		process.exit(1)
	}
	samples.sort((a, b) => a - b)
	const first = samples[0]
	const last = samples[samples.length - 1]
	const mean = samples.reduce((total, value) => total + value, 0) / samples.length
	console.log(`first ${(first / 1000).toFixed(1)}s  last ${(last / 1000).toFixed(1)}s  mean ${(mean / 1000).toFixed(1)}s  of a ${String(remote.START_TIMEOUT_MS)}ms budget`)
	console.log('every run produced a readiness line in the shape READY_LINE parses')
	console.log(leaks.length === 0 ? 'no run leaked a listening Harness' : 'a leak was reported above')
	if (leaks.length > 0) process.exit(1)
}

void main()
