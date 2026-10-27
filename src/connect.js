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
 * The string only the Web UI's document contains.
 *
 * `dsh-web-frontend`'s `index.html` mounts the application on `<div id="root">`. A
 * readiness check that accepts any answer gives a blank tab when the answer is the
 * server's one-line refusal; this is what makes the check ask whether the document is
 * the application. It is a marker in someone else's document, so it is asserted against
 * the installed frontend by `tools/smoke.mjs` — if a future release renames the mount
 * point, that suite fails here rather than an operator discovering it as a blank window.
 */
const APP_MOUNT = 'id="root"'

/**
 * How long the readiness URL may take to answer before a connect is called a failure.
 *
 * Far shorter than `START_TIMEOUT_MS` on purpose, and it is not the same question.
 * That timeout covers a process starting; this one covers a process that has already
 * printed its URL, so the server is up and the only remaining possibility is a server
 * that will not serve — measured, a healthy one answers in single-digit milliseconds.
 * Ten seconds is slack for a slow machine, and small enough that an operator who is
 * waiting learns something rather than watching a tab that says "starting".
 */
const HTTP_READY_TIMEOUT_MS = 10_000

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
 * Wait until the readiness URL is serving the **application**, not a refusal.
 *
 * **The readiness line is not the Web UI being up.** The URL it carries is live within
 * milliseconds — measured on this machine, a token URL answers in 2 ms — but what it
 * answers *with* depends on the request, and the request a `<webview>` makes carries the
 * token from the URL it was given:
 *
 * | request | answer |
 * | --- | --- |
 * | the URL from the readiness line, token included | `303`, `Set-Cookie: dsh-auth-…`, and the app after the redirect |
 * | the same URL with the token stripped or wrong | `400` in 13 ms, **empty body** |
 * | the same URL with a stale `dsh-auth-…` cookie from an earlier run | `401` |
 *
 * A guest navigated to one of the refusals paints the refusal — or, when the body is
 * empty, nothing at all. Either way the tab says `running` and the operator sees a blank
 * rectangle, and reloading re-asks the same question. So the criterion here is not a
 * status code but the question that matters: **does this answer look like the app?**
 * `dsh-web-frontend`'s document carries its mount point, and a refusal is 68 bytes of
 * plain text or nothing.
 *
 * Reading the body costs one response — kilobytes of HTML, already on its way, and only
 * until the marker is found.
 *
 * **An answer that is not the application is returned immediately, not waited out**, and
 * that distinction is the point of the returned `settled`. `ok: false, settled: true` is
 * a server that answered and whose answer will not change — a refusal, or a document
 * that is not the Web UI — and no amount of waiting turns it into the application, so a
 * caller that keeps trying is spending the operator's time to reach the same conclusion.
 * `ok: false, settled: false` is the genuinely transient case: nothing has answered yet,
 * which is what a server that printed its readiness line a moment before it started
 * listening looks like.
 *
 * @param url - the URL from the readiness line, token included.
 * @param timeoutMs - how long to keep trying.
 * @returns `{ ok: true }`, or the answer as `{ ok: false, settled, reason }`.
 */
async function waitForHttpReady(url, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	let last = 'no answer'
	for (;;) {
		try {
			const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
			const status = response.status
			if (status === 303 || status === 302 || status === 307) {
				// The ordinary answer, and it carries no body: the app is behind the
				// redirect, and the cookie that gets there is set by this response.
				return { ok: true }
			}
			const body = (await response.text()).slice(0, 4096)
			if (body.includes(APP_MOUNT)) return { ok: true }
			if (status === 401 || status === 403) {
				return { ok: false, settled: true, reason: `HTTP ${String(status)} (authentication refused)` }
			}
			// A `200` with the wrong body is a server with no Web UI mounted behind it,
			// which for this application is a fact about the install rather than a race.
			return {
				ok: false,
				settled: true,
				reason: status === 200 ? 'HTTP 200 with a body that is not the Web UI' : `HTTP ${String(status)}`
			}
		} catch (error) {
			// `fetch` is strict about what it will call an HTTP answer, and that
			// strictness is welcome here: a socket that accepts a connection and then
			// says something that is not HTTP is exactly the "port is open, nothing is
			// serving" case, and the cause names it. `fetch failed` alone does not.
			// Unlike a wrong body, this one is worth waiting on: it is what a server
			// looks like in the moment before it starts listening.
			last = String(error?.cause?.code ?? error?.cause?.message ?? error?.message ?? error)
		}
		if (Date.now() > deadline) return { ok: false, settled: false, reason: last }
		await new Promise((resolve) => {
			setTimeout(resolve, 150)
		})
	}
}

/**
 * Accept whatever the readiness line announced, without asking it anything.
 *
 * **This is for the remote path only, and it is not a weakening of the check.** The URL
 * a remote Harness prints names *its own* loopback — `http://127.0.0.1:42341/?token=…` —
 * and until phase 2 has opened the tunnel that address means this machine, where nothing
 * is listening. Measured on `hp`: a connect that used the real check there spent the full
 * `HTTP_READY_TIMEOUT_MS` being refused by a port this machine never owned, then failed
 * with `the Harness announced http://127.0.0.1:42017/?token=<hidden> but it answered
 * ECONNREFUSED` — a tab that could not work while the far side was serving perfectly,
 * because the question was asked from the wrong end of a tunnel that did not exist yet.
 *
 * So the check is not dropped for remotes, it is **moved**: `connectRemote` asks it in
 * phase 2 against the loopback URL it builds for the tunnel, which is the first address
 * at which the question has an answer. `connectLocal` needs no such move — its URL is on
 * this machine by construction — and keeps the real check.
 *
 * @returns the accepted answer.
 */
async function servesAnywhere() {
	return { ok: true }
}
/** Marks [servesAnywhere] as asking the far side nothing, so no wait is announced. */
servesAnywhere.quiet = true

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
 * @param check - how to confirm the announced URL serves; defaults to the real HTTP
 *   check. Injectable because a suite cannot spin up a Harness that behaves, and
 *   because the *timing* of that check is what several of its checks are about — a
 *   real `fetch` to a made-up port would make them assertions about the network. A
 *   check carrying `quiet === true` asks the far side nothing and says nothing about
 *   waiting, which is what `connectRemote` passes — see `servesAnywhere`.
 * @returns the URL, or an error.
 */
function awaitReady(child, onLine, timeoutMs, check = waitForHttpReady) {
	return new Promise((resolve) => {
		let raw = ''
		let stderr = ''
		let done = false
		/** Whether the answer is settled and nothing more should be kept. */
		let settled = false
		/** Whether the HTTP check below is in flight, so one line starts one check. */
		let checking = false
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
				if (url !== null) settleOnUrl(url)
			})
		}
		/**
		 * The line has been read; make sure what it points at actually serves.
		 *
		 * **The readiness line is not the Web UI being up.** The URL it carries is
		 * usually live within milliseconds, but "usually" is what leaves an operator
		 * with a tab that says running and shows nothing: the guest is navigated once,
		 * and a refusal it receives then is what it keeps — reloading re-asks with the
		 * same URL and gets the same refusal. So the answer accepted here is an HTTP
		 * answer carrying the token, which `waitForHttpReady` also fails fast and
		 * loudly on the one answer that waiting cannot fix.
		 *
		 * The child is left running on failure: the caller tears it down, which is what
		 * makes this a failed connect rather than a hanging one.
		 *
		 * @param url - the URL from the readiness line.
		 */
		const settleOnUrl = (url) => {
			if (done || checking) return
			checking = true
			const shown = url.replace(/token=[^&]*/u, 'token=<hidden>')
			// A check that asks the far side nothing must not say it is waiting for an
			// answer — the remote path defers that question to phase 2, and a transcript
			// that announces a wait which never happens is worse than a quiet one.
			if (check.quiet !== true) onLine(`waiting for ${shown} to answer`)
			void check(url, HTTP_READY_TIMEOUT_MS).then((answer) => {
				checking = false
				if (done) return
				if (answer.ok) finish({ url })
				else {
					onLine(`! ${shown} answered ${answer.reason}`)
					finish({ error: `the Harness announced ${shown} but it answered ${answer.reason}` })
				}
			})		}
		watch(child.stdout, '')
		watch(child.stderr, '! ')
		child.once('exit', (code) => {
			// A check in flight owns the answer: the process exiting says nothing about
			// whether the page it announced was served, and the check already has the
			// URL. Letting this path settle first would report every successful connect
			// on a Harness that prints its line and then exits as an exit error.
			if (checking) return
			// The process is done printing, so a URL without its trailing newline is
			// as complete as it will ever be.
			const url = remote.readyUrl(raw, true)
			if (url !== null) settleOnUrl(url)
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
async function detectPlatform(device, ssh, onLine, register = () => true) {
	if (device.platform === 'posix' || device.platform === 'windows') return { platform: device.platform }
	const target = `${device.user}@${device.host}`
	const probe = spawn(ssh, [...remote.sshOptions(device), target, 'uname -s'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
	// The probe is a child like any other: a caller that has given up may stop it,
	// and a throw after this point has to be able to stop it too. Before this
	// registration, a cancel during the probe could only set a flag the probe never
	// read, and a stalled banner or a hung login shell had no deadline at all.
	if (!register(probe)) return { error: 'the connect was stopped before it finished' }
	let out = ''
	let err = ''
	/** Whether the deadline, not the probe, ended the wait. */
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		try {
			probe.kill()
		} catch {
			/* already gone */
		}
	}, remote.PROBE_TIMEOUT_MS)
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
	clearTimeout(timer)
	if (timedOut) return { error: `the platform probe did not answer within ${String(remote.PROBE_TIMEOUT_MS / 1000)}s` }
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
async function connectRemoteBody(device, options = {}) {
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

	const detected = await detectPlatform(device, ssh, onLine, keep)
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
	// The announced URL is on the far side of a tunnel this call has not opened yet, so
	// there is nothing here for the real check to reach. Phase 2 asks it instead, against
	// the local address it builds — see `servesAnywhere`.
	const ready = await awaitReady(server, onLine, remote.START_TIMEOUT_MS, servesAnywhere)
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

	// **The door is open; this is the question that says it leads to the app.** A tunnel
	// that accepts connections is not the same as a Harness serving behind it — measured
	// on this machine, a forward can answer a bare TCP connect for a moment before it
	// carries anything — and `waitForHttpReady` is what turns "something is listening"
	// into "the Web UI is there". Asked here rather than in `awaitReady` because this is
	// the first moment the address exists; the URL is built once, below, so what is
	// checked and what the tab is handed cannot drift apart.
	const url = `http://127.0.0.1:${String(localPort)}/${token === null ? '' : `?token=${token}`}`
	const serves = await waitForHttpReady(url, HTTP_READY_TIMEOUT_MS)
	if (!serves.ok) {
		onLine(`! ${url.replace(/token=[^&]*/u, 'token=<hidden>')} answered ${serves.reason}`)
		stopChild(server, true)
		stopChild(tunnel, true)
		live.clear()
		return { error: `the Harness announced a URL the tunnel could not serve: it answered ${serves.reason}` }
	}
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
		url,
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
		},
		/**
		 * Whether either half of this connection is still a live process.
		 *
		 * Asked by a restart, which has to know that the far-side server is really
		 * gone before it starts a replacement. `exitCode` is Node's own record of an
		 * ended child, so this cannot disagree with the `exit` events above about
		 * whether something is still there.
		 *
		 * @returns true while a process this connection owns has not ended.
		 */
		stillRunning() {
			return server.exitCode === null || tunnel.exitCode === null
		}
	}
}

/**
 * Stop a locally spawned Harness shell, and everything under it.
 *
 * On POSIX, closing stdin is the teardown contract the shell itself honours. On
 * Windows that is not sufficient, because the shell resolves `dsh` to a `.cmd` shim:
 * the tree is `cmd.exe → dsh.cmd → node`, and killing only the process this module
 * spawned leaves the other two behind. Measured here: a force-killed application left
 * the local Harness alive and holding its port.
 *
 * `taskkill /T` is used rather than a second `kill()` because it walks the tree, and
 * the application deliberately does not rely on the shell's own `finally` to do it:
 * when Electron is terminated outright, the shell dies before that block runs, which
 * is exactly the case that leaked.
 *
 * **On Windows the tree kill runs before stdin is closed, and that order is a fix.**
 * `taskkill /T` walks a live pid's children; closing stdin is what asks the shell to
 * exit, so a kill issued after the EOF can find nothing to walk and leave the Harness
 * underneath. The remaining hole is a shell that had already exited when this was
 * called — its pid can no longer reach the tree, and the durable fix for that is a
 * supervisor or a Windows job object, not a different order.
 *
 * @param child - the shell process this module spawned.
 */
function stopLocal(child) {
	if (child.exitCode !== null) return
	// **On Windows the tree kill comes first, and the order is the fix for a leak
	// that was measured.** `taskkill /T` walks the children of a *live* pid; closing
	// stdin is what asks the shell to exit, so a kill issued after the EOF can find
	// the shell already gone and no child list left to walk — the Harness underneath
	// survives, holding its loopback port. The README's "the kill has a window" has
	// the measurement. The remaining case is a shell that had already exited when
	// this was called: its pid can no longer reach the tree, and the durable fix for
	// that belongs to a supervisor or a Windows job object rather than to this
	// function.
	//
	// POSIX keeps stdin first: there the EOF is the teardown contract, and the
	// Harness only needs the shell's last `kill $child` to have a shell to run it.
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
		try {
			child.stdin?.end()
		} catch {
			/* the pipe may already be gone */
		}
	} else {
		try {
			child.stdin?.end()
		} catch {
			/* the pipe may already be gone */
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
async function connectLocalBody(options = {}) {
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
		},
		/**
		 * Whether the Harness this connection started is still alive.
		 *
		 * A restart waits on this: the local teardown is `taskkill` on a tree, and a
		 * replacement Harness started before the old one is gone is the "restart did
		 * nothing" the operator cannot tell apart from a restart that worked.
		 *
		 * @returns true while the shell that was spawned has not ended.
		 */
		stillRunning() {
			return child.exitCode === null
		}
	}
}

/**
 * Run one connect, stopping every child it handed over if it throws.
 *
 * **The `onChild` contract only covered a caller that was still listening.** A
 * connect that throws after it has spawned its server has already registered a
 * teardown for that child — but the throw leaves `connectRemoteBody`'s promise
 * rejected, and the only holder of the registration (`main.js`'s attempt) treats
 * the converted error as a failed tab and clears itself. The ssh client and the far
 * side's `dsh web` then run with nothing pointing at them.
 *
 * The wrapper collects the same teardowns the caller is given, and runs them in
 * registration order when the body throws. It does not run them on the ordinary
 * `{ error }` returns: those paths stop their own children, and `main.js` has a
 * second guard for the failure branch.
 *
 * @param options - the connect options, whose `onChild` is wrapped.
 * @param run - the body, called with the wrapped options.
 * @returns the body's result.
 */
async function guarded(options, run) {
	const stops = []
	const caller = options.onChild
	const wrapped = {
		...options,
		onChild: (stop) => {
			stops.push(stop)
			if (typeof caller === 'function') caller(stop)
		}
	}
	try {
		return await run(wrapped)
	} catch (error) {
		for (const stop of stops) {
			try {
				stop()
			} catch {
				/* the original throw is the one to report */
			}
		}
		throw error
	}
}

/**
 * Start a remote device's Harness, with the throw-safe teardown wrappers.
 * @param device - the device record.
 * @param options - `onLine`, `onChild`, `signal`.
 * @returns the connection, or `{ error }`.
 */
async function connectRemote(device, options = {}) {
	return guarded(options, (wrapped) => connectRemoteBody(device, wrapped))
}

/**
 * Start a Harness on this machine, with the throw-safe teardown wrappers.
 * @param options - `onLine`, `directory`, `onChild`, `signal`.
 * @returns the connection, or `{ error }`.
 */
async function connectLocal(options = {}) {
	return guarded(options, (wrapped) => connectLocalBody(wrapped))
}

module.exports = { sshExecutable, freePort, waitForLocalPort, waitForHttpReady, awaitReady, readableStderr, readyUrl: remote.readyUrl, detectPlatform, connectRemote, connectLocal, localVersion, SSH_FAILURE, HTTP_READY_TIMEOUT_MS, APP_MOUNT }
