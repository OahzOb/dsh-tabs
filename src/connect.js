'use strict'

/**
 * The connect path: everything between "the operator picked a device" and "a
 * loopback URL answers".
 *
 * This is deliberately free of any Electron dependency. It is the riskiest code
 * in the application — two ssh connections, a readiness line, a tunnel that binds
 * asynchronously, and a teardown contract whose failure mode is an orphaned
 * server on someone else's machine — and code that can only be exercised by
 * launching a GUI is code that never gets exercised. `tools/live-connect.mjs`
 * drives this module directly, against a real device, with no window anywhere.
 */

const { spawn, spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const net = require('node:net')

const remote = require('./remote.js')
const localdsh = require('./localdsh.js')

/** Exit code ssh uses for its own failures, as opposed to the remote command's. */
const SSH_FAILURE = 255

/**
 * The local `dsh`'s version, probed once for the life of this process.
 *
 * Cached because the answer cannot change while the application runs, and because the
 * launch path is the operator waiting for a tab: paying a few hundred milliseconds on
 * every activation to re-learn the same version would be a cost with no benefit. A
 * process restart picks up an upgrade, which is when it can first have happened.
 *
 * @type {Promise<{reported: string|null, problem: string|null}>|undefined}
 */
let localVersionCache

/**
 * Probe the local `dsh`, once.
 * @returns the version found, and the problem with it when there is one.
 */
function localVersion() {
	if (localVersionCache === undefined) {
		localVersionCache = localdsh.probeLocalDsh(process.platform).then((result) => ({
			reported: result.version,
			problem: localdsh.versionProblem(result.version, result.output)
		}))
	}
	return localVersionCache
}

/**
 * Locate the ssh client.
 *
 * A packaged app is not launched from a developer shell, so PATH is not assumed:
 * the System32 copy is the one Windows' own optional feature installs.
 * @returns the executable path or bare name.
 */
function sshExecutable() {
	if (process.platform === 'win32') {
		const candidate = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
		if (existsSync(candidate)) return candidate
	}
	return 'ssh'
}

/**
 * Ask the OS for an unused loopback port.
 * @returns the port number.
 */
function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer()
		server.on('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			const port = typeof address === 'object' && address !== null ? address.port : 0
			server.close(() => {
				resolve(port)
			})
		})
	})
}

/**
 * Wait until a local port accepts a connection.
 *
 * The tunnel process existing is not the same as the tunnel working: `ssh -L`
 * binds asynchronously, and navigating a guest before the forward is live
 * produces a connection-refused error page that looks like a broken device.
 *
 * @param port - the local port to probe.
 * @param timeoutMs - how long to keep trying.
 * @returns true when the port answered.
 */
function waitForLocalPort(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	return new Promise((resolve) => {
		const attempt = () => {
			const socket = net.connect({ port, host: '127.0.0.1' })
			socket.once('connect', () => {
				socket.destroy()
				resolve(true)
			})
			socket.once('error', () => {
				socket.destroy()
				if (Date.now() > deadline) resolve(false)
				else setTimeout(attempt, 120)
			})
		}
		attempt()
	})
}

/**
 * The readable part of a remote's stderr, for a failure message.
 *
 * PowerShell serialises its error stream as **CLIXML** whenever stderr is redirected,
 * so a Windows remote that fails sends one large `<Objs …>` document rather than the
 * sentences inside it. Measured against a real Windows host: 1131 bytes across two
 * lines, of which the only useful part was
 *
 *     Set-Location : Cannot find path 'C:\…' because it does not exist.
 *
 * — buried in an `<S S="Error">` record with its newlines escaped as `_x000D_` and
 * `_x000A_`. Reporting the raw text would put that whole document in the failure
 * panel; reporting nothing is what this function replaced, and it meant the operator
 * saw only "exited with code 1" while the far side had already said what was wrong.
 *
 * The transcript keeps the raw line either way, so nothing is hidden — this only
 * decides what the *message* says.
 *
 * @param text - everything the stream carried.
 * @returns one line, or an empty string when there is nothing to say.
 */
function readableStderr(text) {
	const raw = String(text ?? '')
	// **The first error record is the one that names the fault**; the rest of a
	// PowerShell error is the source excerpt, `At line:… char:…` and `CategoryInfo`,
	// which is for whoever edits the script rather than whoever is trying to connect.
	// Taking only the first keeps the message to the sentence that helps.
	const records = [...raw.matchAll(/<S S="Error">([\s\S]*?)<\/S>/gu)].map((match) =>
		match[1].replace(/_x000D_/gu, ' ').replace(/_x000A_/gu, ' ').trim()
	)
	// No CLIXML: an ordinary shell's stderr is already what a reader wants, and it is
	// kept whole because there is no such structure to trim.
	const chosen = records.length > 0 ? (records[0] ?? '') : raw.replace(/#<\s*CLIXML/gu, '')
	const collapsed = chosen.replace(/\s+/gu, ' ').trim()
	// Enough to name the problem, short enough not to become the whole panel.
	return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed
}

/**
 * Stop a spawned process, whichever of its two halves is the one that reaps it.
 *
 * `connectLocal` needs this to hand a teardown to its caller before it has
 * finished connecting, and the two branches are genuinely different code:
 * `stopLocal` on Windows walks the process tree with a synchronous `taskkill`,
 * while a remote server's connection is reaped by closing the ssh client's stdin.
 *
 * @param child - the process this module spawned.
 * @param ssh - true when the child is an ssh client rather than a local shell.
 */
function stopChild(child, ssh) {
	if (ssh) {
		try {
			child.stdin?.end()
		} catch {
			/* the pipe may already be gone */
		}
		try {
			child.kill()
		} catch {
			/* already gone */
		}
		return
	}
	stopLocal(child)
}

/**
 * Read a server's readiness line from its output.
 *
 * Both streams are watched: `dsh web` prints the URL on stdout, but anything it
 * complains about on the way lands on stderr, and a caller that waited only on
 * stdout would report a timeout with an empty transcript.
 *
 * **Nothing is accumulated or re-parsed once the line is settled, and the listener
 * stays attached anyway.** Both halves of that are deliberate. Before: every chunk
 * for the life of the connection was appended to a buffer and re-scanned with
 * `readyUrl`, which slices at the last newline and runs a regular expression over
 * the whole thing — so a session that ran for an hour held an hour of output, and
 * each new chunk cost a pass over all of it. Measured with a `PassThrough` in
 * place of the child: five chunks after the resolution produced five more `onLine`
 * calls and 600 kB of retained text. After: the same five produce none and retain
 * none. The listener cannot be *removed*, because a pipe nobody reads fills and the
 * child blocks on its next write — the readiness line is printed before the Harness
 * starts serving, so the process that would block is the very one being waited for.
 *
 * What this gives up is the post-readiness tail of the transcript: the tab records
 * a connect, and what the server prints afterwards is no longer appended to it.
 * That is what the memory and the O(total) scan were buying, and a connect is not a
 * session log.
 *
 * The result carries `buffered()` — the bytes held at that moment — because "it did
 * not grow" is otherwise a claim about a private variable, and the suite that pins
 * this has to be able to see it.
 *
 * @param child - the server process.
 * @param onLine - receives each transcript line, already prefixed.
 * @param timeoutMs - how long to wait.
 * @returns the URL, or an error.
 */
function awaitReady(child, onLine, timeoutMs) {
	return new Promise((resolve) => {
		let raw = ''
		let stderr = ''
		let done = false
		/** Whether the answer is settled and nothing more should be kept. */
		let settled = false
		const finish = (value) => {
			if (done) return
			done = true
			settled = true
			clearTimeout(timer)
			resolve({ ...value, buffered: () => raw.length + stderr.length })
		}
		const timer = setTimeout(() => {
			// The same flag as the resolved path, and it matters more here: the timeout
			// fires once, and a child that never announces a URL keeps printing for as
			// long as the connection is up — so the failure path is the one that
			// accumulates longest if it is left out.
			settled = true
			finish({ error: `the Harness never announced a URL within ${String(Math.round(timeoutMs / 1000))}s` })
		}, timeoutMs)
		const watch = (stream, prefix) => {
			if (stream === null || stream === undefined) return
			stream.setEncoding('utf8')
			stream.on('data', (chunk) => {
				if (settled) return
				for (const line of String(chunk).split(/\r?\n/u)) {
					if (line.trim() !== '') onLine(`${prefix}${line}`)
				}
				raw += chunk
				if (prefix === '! ') stderr += chunk
				const url = remote.readyUrl(raw)
				if (url !== null) finish({ url })
			})
		}
		watch(child.stdout, '')
		watch(child.stderr, '! ')
		child.once('exit', (code) => {
			// The process is done printing, so a URL without its trailing newline is
			// as complete as it will ever be.
			const url = remote.readyUrl(raw, true)
			if (url !== null) finish({ url })
			else {
				// The far side usually said why. Repeating it here is the difference
				// between "exited with code 1" and the sentence that names the fault.
				const said = readableStderr(stderr)
				finish({
					error:
						`the remote command exited with code ${String(code)} before announcing a URL` +
						(said === '' ? '' : ` — it said: ${said}`)
				})
			}
		})
		child.once('error', (error) => {
			finish({ error: error.message })
		})
	})
}

/**
 * Which shell family the far side speaks, cached on the device record.
 *
 * `uname -s` is one argv element with no metacharacters, so it survives every
 * shell. Only ssh's own exit code 255 means the connection failed, and that is
 * reported as the connect failure rather than being mistaken for a platform — an
 * unreachable host must fail **once**, with the ssh error, instead of twice
 * under a platform guess.
 *
 * @param device - the device to classify.
 * @param ssh - the resolved ssh executable.
 * @param onLine - receives each transcript line.
 * @returns the platform, or the error.
 */
async function detectPlatform(device, ssh, onLine) {
	if (device.platform === 'posix' || device.platform === 'windows') return { platform: device.platform }
	const target = `${device.user}@${device.host}`
	const probe = spawn(ssh, [...remote.sshOptions(device), target, 'uname -s'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
	let out = ''
	let err = ''
	probe.stdout.setEncoding('utf8')
	probe.stderr.setEncoding('utf8')
	probe.stdout.on('data', (chunk) => {
		out += chunk
	})
	probe.stderr.on('data', (chunk) => {
		err += chunk
	})
	const code = await new Promise((resolve) => {
		probe.once('exit', (value) => {
			resolve(value ?? 0)
		})
		probe.once('error', () => {
			resolve(SSH_FAILURE)
		})
	})
	const classified = remote.classifyPlatform(code, out)
	if (classified.error === true) return { error: (err.trim() || out.trim() || 'ssh failed').split(/\r?\n/u)[0] }
	return { platform: classified.platform }
}

/**
 * Start a remote device's Harness and forward a local port to it.
 *
 * Two ssh connections, deliberately. The first runs the server with an
 * OS-chosen port, so a connect can never collide with anything already on that
 * machine; the second is a bare forward to whatever port the first announced.
 *
 * @param device - the device record.
 * @param options - `onLine` for the transcript, `onChild` for teardown in flight,
 *   `signal` to be told the caller has given up.
 * @returns the URL, the platform, and a `stop` that honours the teardown contract.
 */
async function connectRemote(device, options = {}) {
	const onLine = typeof options.onLine === 'function' ? options.onLine : () => {}
	/** Told about each process the moment it exists, so a caller that cancels mid-connect has something to stop. */
	const onChild = typeof options.onChild === 'function' ? options.onChild : () => {}
	const signal = options.signal
	const ssh = sshExecutable()
	const target = `${device.user}@${device.host}`
	onLine(`connect ${target}:${String(device.sshPort)}`)

	// Two clients are spawned a long way apart — a platform probe, a readiness line,
	// a port and a tunnel probe sit between them — so a cancellation is carried as a
	// local flag rather than as one listener on one process. That flag is what the
	// checks between the phases read, and what makes "the tab was stopped while it
	// was still connecting" leave nothing behind on the far side.
	let stopped = false
	/** Every ssh client this call has started and not yet handed over. */
	const live = new Set()
	/**
	 * Register one ssh client, tearing it down instead if the caller has already gone.
	 * @param child - the client just spawned.
	 * @returns false when the connect must stop here.
	 */
	const keep = (child) => {
		const stop = () => {
			stopped = true
			stopChild(child, true)
		}
		if (signal?.aborted === true) {
			stop()
			return false
		}
		live.add(child)
		onChild(stop)
		signal?.addEventListener('abort', stop, { once: true })
		return true
	}
	/**
	 * The check between two phases: has the caller gone, and is there anything of
	 * ours still standing? Both, because the long waits in between — the platform
	 * probe and the port allocation — hold no child at all, so an abort during one of
	 * them sets no flag here. Returning true means nothing of ours may continue.
	 * @returns true when this call must unwind.
	 */
	const cancelled = () => {
		if (stopped || signal?.aborted === true) {
			for (const child of live) stopChild(child, true)
			live.clear()
			return true
		}
		return false
	}
	/** The connection is the caller's from here, so nothing may be torn down again. */
	const handOver = () => {
		live.clear()
	}

	const detected = await detectPlatform(device, ssh, onLine)
	if (detected.error !== undefined) return { error: detected.error }
	const platform = detected.platform
	onLine(`remote platform: ${platform}`)
	if (cancelled()) return { error: 'the connect was stopped before it finished' }

	//#region phase 1 — start the server, learn the port it chose
	const program = remote.remoteProgram(device, platform)
	const server = spawn(ssh, [...remote.sshOptions(device), target, remote.remoteCommand(program, platform)], {
		// stdin MUST stay an open pipe: its closure at teardown is what reaps the
		// remote server. Never written to.
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true
	})
	if (!keep(server)) return { error: 'the connect was stopped before it finished' }
	const ready = await awaitReady(server, onLine, remote.START_TIMEOUT_MS)
	if (ready.error !== undefined) {
		stopChild(server, true)
		live.clear()
		return { error: ready.error }
	}
	if (cancelled()) return { error: 'the connect was stopped before it finished' }
	//#endregion

	//#region phase 2 — forward a local port to the port the remote announced
	const { port: remotePort, token } = remote.parseReadyUrl(ready.url)
	const localPort = await freePort()
	if (cancelled()) return { error: 'the connect was stopped before it finished' }
	onLine(`tunnel 127.0.0.1:${String(localPort)} -> 127.0.0.1:${String(remotePort)}`)
	const tunnel = spawn(ssh, [...remote.sshOptions(device), '-N', '-L', `${String(localPort)}:127.0.0.1:${String(remotePort)}`, target], {
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true
	})
	if (!keep(tunnel)) return { error: 'the connect was stopped before it finished' }
	tunnel.stderr?.setEncoding('utf8')
	tunnel.stderr?.on('data', (chunk) => {
		for (const line of String(chunk).split(/\r?\n/u)) {
			if (line.trim() !== '') onLine(`! ${line}`)
		}
	})
	if (!(await waitForLocalPort(localPort, remote.TUNNEL_TIMEOUT_MS))) {
		stopChild(server, true)
		stopChild(tunnel, true)
		live.clear()
		return { error: 'the ssh tunnel never began accepting connections' }
	}
	if (cancelled()) return { error: 'the connect was stopped before it finished' }
	//#endregion

	// From here the connection is the caller's, so a later abort must find nothing:
	// the listener stays registered — the signal belongs to the caller, and there is
	// no reason to spend a remover on it — but the set it walks is emptied.
	handOver()

	return {
		platform,
		localPort,
		remotePort,
		token,
		url: `http://127.0.0.1:${String(localPort)}/${token === null ? '' : `?token=${token}`}`,
		/**
		 * Honor the teardown contract.
		 *
		 * Order matters. Ending the server connection's stdin reaches EOF on the
		 * far side, which is what makes the remote `dsh web` exit; killing the ssh
		 * client first would drop the connection without the far side ever
		 * learning it should stop, leaving an orphaned server holding the port.
		 */
		stop() {
			if (server.exitCode === null) {
				try {
					server.stdin?.end()
				} catch {
					/* the pipe may already be gone */
				}
			}
			if (tunnel.exitCode === null) {
				try {
					tunnel.kill()
				} catch {
					/* already gone */
				}
			}
		},
		/** Fires when the server connection ends on its own. */
		onServerExit(listener) {
			server.once('exit', (code) => {
				listener(code)
			})
		},
		/** Fires when the tunnel ends on its own. */
		onTunnelExit(listener) {
			tunnel.once('exit', (code) => {
				listener(code)
			})
		}
	}
}

/**
 * Stop a locally spawned Harness shell, and everything under it.
 *
 * Closing stdin first is the teardown contract the shell itself honours — but on
 * Windows that is not sufficient, because the shell resolves `dsh` to a `.cmd`
 * shim: the tree is `powershell → cmd.exe → node`, and killing only the process
 * this module spawned leaves the other two behind. Measured here: a force-killed
 * application left the local Harness alive and holding its port.
 *
 * `taskkill /T` is used rather than a second `kill()` because it walks the tree,
 * and the application deliberately does not rely on the shell's own `finally` to
 * do it: when Electron is terminated outright, the shell dies before that block
 * runs, which is exactly the case that leaked.
 *
 * @param child - the shell process this module spawned.
 */
function stopLocal(child) {
	if (child.exitCode !== null) return
	try {
		child.stdin?.end()
	} catch {
		/* the pipe may already be gone */
	}
	if (process.platform === 'win32') {
		try {
			// SYNCHRONOUS on purpose. An asynchronous `spawn('taskkill', …)` is a
			// child of this application, and the application is usually in
			// `before-quit` when this runs — it exits before the async child has
			// done anything, which is exactly how the Harness leaked a second time.
			// `taskkill` takes tens of milliseconds, and blocking the quit for that
			// is the whole point.
			spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
		} catch {
			/* fall through to the single kill */
		}
	}
	try {
		child.kill()
	} catch {
		/* already gone */
	}
}

/**
 * Start a Harness on this machine, for the local tab.
 *
 * @param options - `onLine` for the transcript, `directory` for where it starts,
 *   `onChild` for teardown in flight, `signal` to be told the caller has given up.
 * @returns the URL and a `stop`.
 */
async function connectLocal(options = {}) {
	const onLine = typeof options.onLine === 'function' ? options.onLine : () => {}
	/** Told about the shell the moment it exists, so a caller that cancels mid-connect can stop it. */
	const onChild = typeof options.onChild === 'function' ? options.onChild : () => {}
	const signal = options.signal
	// The local tab's directory comes from the device book exactly as a remote's
	// does, and on Windows it has to survive being placed inside one `cmd` command
	// string — the one place in this application that cannot quote a path safely.
	// Refusing it here fails the tab with a reason, instead of building a line whose
	// meaning is not the one intended.
	const problem = remote.directoryProblem(options.directory)
	if (problem !== null) return { error: problem }

	// Which `dsh` is on PATH decides whether the local tab works at all, and the way it
	// fails when it is too old points at credentials rather than at the version. See
	// `localdsh.js`. Probed once per process, because the answer cannot change while
	// this application is running and the launch path is the operator waiting.
	const version = await localVersion()
	if (version.problem !== null) {
		onLine(`! ${version.problem}`)
		return { error: version.problem }
	}
	if (version.reported !== null) onLine(`local dsh: ${version.reported}`)
	// The probe above is a process of its own and takes long enough to be worth
	// cancelling across. The abort listener below covers the wait that follows; this
	// one covers the version probe, so a `×` during it is not answered by spawning a
	// Harness into a tab that no longer exists. Nothing is spawned by this call
	// before here, so there is nothing to tear down — only something to not start.
	if (signal?.aborted === true) return { error: 'the connect was stopped before it finished' }

	const argv = remote.localDshArgv(process.platform, options.directory)
	onLine(`local program: ${argv.join(' ')}`)
	const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
	// Handed over *before* the readiness wait, which is the longest window of the
	// whole connect and the one an operator is most likely to cancel in.
	const stop = () => {
		stopLocal(child)
	}
	onChild(stop)
	signal?.addEventListener('abort', stop, { once: true })
	const ready = await awaitReady(child, onLine, remote.START_TIMEOUT_MS)
	if (ready.error !== undefined) {
		stopLocal(child)
		return { error: ready.error }
	}
	// A cancellation that arrived during the readiness wait killed the child, which is
	// why `awaitReady` answered at all — and the caller discards this result, because
	// the attempt that asked for it has been cancelled. Not stopping a second time is
	// `main.js`'s job: its attempt record marks a teardown that has already run.
	return {
		url: ready.url,
		port: remote.parseReadyUrl(ready.url).port,
		stop() {
			stopLocal(child)
		},
		onServerExit(listener) {
			child.once('exit', (code) => {
				listener(code)
			})
		}
	}
}

module.exports = { sshExecutable, freePort, waitForLocalPort, awaitReady, readableStderr, readyUrl: remote.readyUrl, detectPlatform, connectRemote, connectLocal, localVersion, SSH_FAILURE }
