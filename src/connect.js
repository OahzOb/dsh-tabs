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
 * Read a server's readiness line from its output.
 *
 * Both streams are watched: `dsh web` prints the URL on stdout, but anything it
 * complains about on the way lands on stderr, and a caller that waited only on
 * stdout would report a timeout with an empty transcript.
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
		const finish = (value) => {
			if (done) return
			done = true
			clearTimeout(timer)
			resolve(value)
		}
		const timer = setTimeout(() => {
			finish({ error: `the Harness never announced a URL within ${String(Math.round(timeoutMs / 1000))}s` })
		}, timeoutMs)
		const watch = (stream, prefix) => {
			if (stream === null || stream === undefined) return
			stream.setEncoding('utf8')
			stream.on('data', (chunk) => {
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
 * @param options - `onLine` for the transcript, `signal` unused.
 * @returns the URL, the platform, and a `stop` that honours the teardown contract.
 */
async function connectRemote(device, options = {}) {
	const onLine = typeof options.onLine === 'function' ? options.onLine : () => {}
	const ssh = sshExecutable()
	const target = `${device.user}@${device.host}`
	onLine(`connect ${target}:${String(device.sshPort)}`)

	const detected = await detectPlatform(device, ssh, onLine)
	if (detected.error !== undefined) return { error: detected.error }
	const platform = detected.platform
	onLine(`remote platform: ${platform}`)

	//#region phase 1 — start the server, learn the port it chose
	const program = remote.remoteProgram(device, platform)
	const server = spawn(ssh, [...remote.sshOptions(device), target, remote.remoteCommand(program, platform)], {
		// stdin MUST stay an open pipe: its closure at teardown is what reaps the
		// remote server. Never written to.
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true
	})
	const ready = await awaitReady(server, onLine, remote.START_TIMEOUT_MS)
	if (ready.error !== undefined) {
		server.stdin?.end()
		server.kill()
		return { error: ready.error }
	}
	//#endregion

	//#region phase 2 — forward a local port to the port the remote announced
	const { port: remotePort, token } = remote.parseReadyUrl(ready.url)
	const localPort = await freePort()
	onLine(`tunnel 127.0.0.1:${String(localPort)} -> 127.0.0.1:${String(remotePort)}`)
	const tunnel = spawn(ssh, [...remote.sshOptions(device), '-N', '-L', `${String(localPort)}:127.0.0.1:${String(remotePort)}`, target], {
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true
	})
	tunnel.stderr?.setEncoding('utf8')
	tunnel.stderr?.on('data', (chunk) => {
		for (const line of String(chunk).split(/\r?\n/u)) {
			if (line.trim() !== '') onLine(`! ${line}`)
		}
	})
	if (!(await waitForLocalPort(localPort, remote.TUNNEL_TIMEOUT_MS))) {
		server.stdin?.end()
		server.kill()
		tunnel.kill()
		return { error: 'the ssh tunnel never began accepting connections' }
	}
	//#endregion

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
 * @param options - `onLine` for the transcript, `directory` for where it starts.
 * @returns the URL and a `stop`.
 */
async function connectLocal(options = {}) {
	const onLine = typeof options.onLine === 'function' ? options.onLine : () => {}
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

	const argv = remote.localDshArgv(process.platform, options.directory)
	onLine(`local program: ${argv.join(' ')}`)
	const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
	const ready = await awaitReady(child, onLine, remote.START_TIMEOUT_MS)
	if (ready.error !== undefined) {
		stopLocal(child)
		return { error: ready.error }
	}
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
