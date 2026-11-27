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
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { homedir } = require('node:os')
const net = require('node:net')

const remote = require('./remote.js')
const localdsh = require('./localdsh.js')
const askpass = require('./askpass.js')
const addresses = require('./addresses.js')

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
 * Spawn one ssh client with the options and environment its device asks for.
 *
 * Every ssh invocation in this module goes through here, which is what makes "a
 * password device never gets `BatchMode=yes`" and "a password device always gets
 * its askpass helper" properties of one function rather than of five call sites
 * remembering. The environment is only replaced when there is something to add:
 * `spawn` already inherits `process.env`, and copying it for a key device would
 * make every future variable change a thing to remember here.
 *
 * @param ssh - the ssh executable.
 * @param device - the device being reached.
 * @param authEnv - the askpass variables, or undefined for a key device.
 * @param args - everything after the option block.
 * @param options - the spawn options.
 * @returns the child process.
 */
function spawnSsh(ssh, device, authEnv, args, options) {
	return spawn(ssh, [...remote.sshOptionsFor(device), ...args], {
		...options,
		...(authEnv === undefined ? {} : { env: { ...process.env, ...authEnv } })
	})
}

/**
 * The askpass environment for one connect, when the device needs one.
 *
 * A missing password is refused here rather than left to ssh: with `BatchMode=no`
 * and no helper, a GUI-launched ssh can do nothing but print `Permission denied`,
 * which names the wrong problem. The refusal names the right one, and the caller
 * has already asked the operator by the time this runs.
 *
 * @param device - the device being reached.
 * @param options - `password` and `askpassDir`.
 * @returns the variables, or undefined for a key device.
 */
function authEnvFor(device, options) {
	if (device.auth !== 'password') return undefined
	if (typeof options.password !== 'string' || options.password === '') {
		throw new Error('this device authenticates with a password, and none was supplied')
	}
	if (typeof options.askpassDir !== 'string' || options.askpassDir === '') {
		throw new Error('a password-authenticated connection needs a directory for its askpass helper')
	}
	return askpass.envFor(options.password, options.askpassDir)
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
 * is listening. Measured on a Linux host: a connect that used the real check there spent the full
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
 * Read the persistent-host program's output until it names a URL.
 *
 * The program adopts or starts a host, says which (`HOST adopted …` or
 * `HOST started …`), and then prints the ordinary readiness line. So this asks
 * the same question `awaitReady` asks, with one extra answer — *was it already
 * there?* — and it reports the program's own `HOST error …` line instead of an
 * exit code, because that line is the one written to be read.
 *
 * @param child - the one-shot ssh client running the ensure program.
 * @param onLine - receives each transcript line.
 * @returns the URL and whether it was adopted, or the reason it failed.
 */
function awaitEnsure(child, onLine, spawnName = 'ssh') {
	return new Promise((resolve) => {
		let raw = ''
		let err = ''
		let settled = false
		/**
		 * Settle once, and stop the client: the ensure program has already done its
		 * work by then, so a lingering ssh client is only a stray process.
		 * @param value - the result to resolve with.
		 * @param stop - whether to kill the client.
		 */
		const finish = (value, stop = false) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (stop) {
				try {
					child.kill()
				} catch {
					/* already gone */
				}
			}
			resolve(value)
		}
		// The program gives up on its own at `HOST_START_TIMEOUT_MS`; this is the
		// deadline for the *channel*, which is a different thing and can hang on its
		// own — a wedged ssh client holds no output at all.
		const timer = setTimeout(() => {
			finish({ error: `the persistent host did not answer within ${String(Math.round(remote.HOST_START_TIMEOUT_MS / 1000))}s` }, true)
		}, remote.HOST_START_TIMEOUT_MS + 15_000)
		const adopted = () => /^HOST adopted /mu.test(raw)
		child.stdout.setEncoding('utf8')
		child.stderr.setEncoding('utf8')
		child.stdout.on('data', (chunk) => {
			raw += chunk
			for (const line of String(chunk).split(/\r?\n/u)) {
				if (line.trim() === '') continue
				onLine(line)
				const failed = /^HOST error (.+)$/u.exec(line)
				if (failed !== null) {
					finish({ error: failed[1] })
					return
				}
			}
			if (settled) return
			const url = remote.readyUrl(raw)
			// **The client is stopped once the URL is in hand, and that is not tidiness.**
			// The ensure program has already finished its work by then — the host is
			// detached — but the ssh *channel* can stay open for a reason that has
			// nothing to do with the Harness: a login profile on the far side that leaves
			// a background process holding the session's stdout. Measured on a real Linux
			// remote where even `ssh host 'echo hi'` never returned. Waiting for an exit
			// that may never come would hang every persistent connect on such a host.
			if (url !== null) finish({ url, adopted: adopted() }, true)
		})
		child.stderr.on('data', (chunk) => {
			err += chunk
			for (const line of String(chunk).split(/\r?\n/u)) {
				if (line.trim() !== '') onLine(`! ${line}`)
			}
		})
		child.once('exit', () => {
			if (settled) return
			// The line may be unterminated when the client closes: the process is known
			// to have stopped by now, so the partial-line rule applies.
			const url = remote.readyUrl(raw, true)
			if (url !== null) {
				finish({ url, adopted: adopted() })
				return
			}
			const said = raw.trim().split(/\r?\n/u).filter((line) => line.trim() !== '').pop()
			finish({ error: said ?? (err.trim().split(/\r?\n/u)[0] || 'the persistent host command exited without announcing a URL') })
		})
		child.once('error', () => {
			finish({ error: `${spawnName} could not be started`, stop: true })
		})
	})
}

/**
 * Stop the host a persistent device is using, and remove its record.
 *
 * Run only from an explicit operator action — "Stop host" on the device, or a
 * reap the operator confirmed — because the host may be serving another client
 * and the work it is doing belongs to somebody.
 *
 * @param device - the device whose host is being stopped.
 * @param platform - the shell family the far side speaks.
 * @param ssh - the resolved ssh executable.
 * @param onLine - receives each transcript line.
 * @param authEnv - the askpass variables for a password device, or undefined.
 * @returns the stop program's stdout lines.
 */
async function stopPersistentHost(device, platform, ssh, onLine, authEnv) {
	const target = `${device.user}@${device.host}`
	const child = spawnSsh(ssh, device, authEnv, [target, remote.remoteCommand(remote.persistentStopProgram(device, platform), platform)], {
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true
	})
	const lines = []
	child.stdout?.setEncoding('utf8')
	child.stderr?.setEncoding('utf8')
	child.stdout?.on('data', (chunk) => {
		for (const line of String(chunk).split(/\r?\n/u)) {
			if (line.trim() === '') continue
			lines.push(line)
			onLine(line)
		}
	})
	child.stderr?.on('data', (chunk) => {
		for (const line of String(chunk).split(/\r?\n/u)) {
			if (line.trim() !== '') onLine(`! ${line}`)
		}
	})
	// Bounded, for the same reason `awaitEnsure` stops its client: the stop program
	// exits, but the channel need not. The work is done either way — the record is
	// gone and the pid is dead — so waiting is only about the transcript.
	await new Promise((resolve) => {
		const timer = setTimeout(() => {
			try {
				child.kill()
			} catch {
				/* already gone */
			}
			resolve(undefined)
		}, 20_000)
		timer.unref?.()
		child.once('exit', () => {
			clearTimeout(timer)
			resolve(undefined)
		})
		child.once('error', () => {
			clearTimeout(timer)
			resolve(undefined)
		})
	})
	return lines
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
 * @param register - tells the caller about the probe so it can be stopped.
 * @param authEnv - the askpass variables for a password device, or undefined.
 * @returns the platform, or the error.
 */
async function detectPlatform(device, ssh, onLine, register = () => true, authEnv) {
	if (device.platform === 'posix' || device.platform === 'windows') return { platform: device.platform }
	const target = `${device.user}@${device.host}`
	const probe = spawnSsh(ssh, device, authEnv, [target, 'uname -s'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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
 *   `signal` to be told the caller has given up, and `password`/`askpassDir` for a
 *   device whose account authenticates by password.
 * @returns the URL, the platform, and a `stop` that honours the teardown contract.
 */
async function connectRemoteBody(device, options = {}) {
	const onLine = typeof options.onLine === 'function' ? options.onLine : () => {}
	/** Told about each process the moment it exists, so a caller that cancels mid-connect has something to stop. */
	const onChild = typeof options.onChild === 'function' ? options.onChild : () => {}
	const signal = options.signal
	const ssh = sshExecutable()
	// The address is chosen before ssh starts, so the probe, the server and the
	// tunnel all reach the same machine by the same path. A cancel during the
	// probes leaves nothing spawned, but still has to stop this connect here.
	const chosen = await resolveAddress(device, {
		onLine,
		signal,
		probe: options.addressProbe,
		timeoutMs: options.addressTimeoutMs
	})
	if (signal?.aborted === true || chosen.cancelled === true) return { error: 'the connect was stopped before it finished' }
	device = chosen.device
	const target = `${device.user}@${device.host}`
	const authEnv = authEnvFor(device, options)
	onLine(`connect ${target}:${String(device.sshPort)}`)

	// **A persistent device owns a host that is not this connection's to end.** It is
	// adopted or started by a one-shot command, the tunnel is the only thing this
	// connection keeps alive, and closing the tab must mean "detach", not "kill".
	const persistent = device.mode === 'persistent'
	// A stable local port is what makes the browser's cookie and the page's own
	// `dsh.sessions.current` survive a reconnect: both are keyed by origin, and an
	// ephemeral port changes it on every connect. A device that names one gets it.
	const fixedPort = persistent && Number.isInteger(device.localPort) && device.localPort > 0 ? device.localPort : undefined

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

	const detected = await detectPlatform(device, ssh, onLine, keep, authEnv)
	if (detected.error !== undefined) return { error: detected.error }
	const platform = detected.platform
	onLine(`remote platform: ${platform}`)
	if (cancelled()) return { error: 'the connect was stopped before it finished' }

	//#region phase 1 — start (or adopt) the far side, learn the port it chose
	let hold = null
	let adopted = false
	let announced
	if (persistent) {
		// One-shot: adopt the recorded host or start one that outlives this channel.
		// `stdio` is deliberately `ignore` on stdin — nothing here holds the far side
		// open, because the host's lifetime is its record, not this pipe.
		const ensure = spawnSsh(ssh, device, authEnv, [target, remote.remoteCommand(remote.persistentEnsureProgram(device, platform), platform)], {
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		})
		if (!keep(ensure)) return { error: 'the connect was stopped before it finished' }
		const ensured = await awaitEnsure(ensure, onLine)
		live.delete(ensure)
		if (ensured.error !== undefined) return { error: ensured.error }
		adopted = ensured.adopted === true
		announced = ensured.url
		onLine(adopted ? 'reusing the host this home already had' : 'started a host that will outlive this connection')
	} else {
		const program = remote.remoteProgram(device, platform)
		hold = spawnSsh(ssh, device, authEnv, [target, remote.remoteCommand(program, platform)], {
			// stdin MUST stay an open pipe: its closure at teardown is what reaps the
			// remote server. Never written to.
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true
		})
		if (!keep(hold)) return { error: 'the connect was stopped before it finished' }
		// The announced URL is on the far side of a tunnel this call has not opened yet,
		// so there is nothing here for the real check to reach. Phase 2 asks it instead,
		// against the local address it builds — see `servesAnywhere`.
		const ready = await awaitReady(hold, onLine, remote.START_TIMEOUT_MS, servesAnywhere)
		if (ready.error !== undefined) {
			stopChild(hold, true)
			live.clear()
			return { error: ready.error }
		}
		announced = ready.url
	}
	if (cancelled()) return { error: 'the connect was stopped before it finished' }
	//#endregion

	//#region phase 2 — forward a local port to the port the remote announced
	const { port: remotePort, token } = remote.parseReadyUrl(announced)
	const localPort = fixedPort ?? await freePort()
	if (cancelled()) return { error: 'the connect was stopped before it finished' }
	onLine(`tunnel 127.0.0.1:${String(localPort)} -> 127.0.0.1:${String(remotePort)}`)
	const tunnel = spawnSsh(ssh, device, authEnv, ['-N', '-L', `${String(localPort)}:127.0.0.1:${String(remotePort)}`, target], {
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
		if (hold !== null) stopChild(hold, true)
		stopChild(tunnel, true)
		live.clear()
		return {
			error: fixedPort === undefined
				? 'the ssh tunnel never began accepting connections'
				: `the local port ${String(localPort)} is already in use, so the tunnel could not listen on it`
		}
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
		if (hold !== null) stopChild(hold, true)
		stopChild(tunnel, true)
		live.clear()
		return { error: `the Harness announced a URL the tunnel could not serve: it answered ${serves.reason}` }
	}
	//#endregion

	// From here the connection is the caller's, so a later abort must find nothing:
	// the listener stays registered — the signal belongs to the caller, and there is
	// no reason to spend a remover on it — but the set it walks is emptied.
	handOver()

	/** End the ephemeral exec channel: its stdin EOF is what reaps the far side. */
	const endHold = () => {
		if (hold === null || hold.exitCode !== null) return
		try {
			hold.stdin?.end()
		} catch {
			/* the pipe may already be gone */
		}
	}
	/** Drop the forward. A host behind it is not this connection's to end. */
	const closeTunnel = () => {
		if (tunnel.exitCode === null) {
			try {
				tunnel.kill()
			} catch {
				/* already gone */
			}
		}
	}

	return {
		platform,
		localPort,
		remotePort,
		token,
		url,
		/** Whether this connection adopted or started a host that outlives it. */
		persistent,
		/** Whether the host already existed when this connection arrived. */
		adopted,
		/**
		 * Honor the teardown contract.
		 *
		 * Order matters on the ephemeral path. Ending the server connection's stdin
		 * reaches EOF on the far side, which is what makes the remote `dsh web` exit;
		 * killing the ssh client first would drop the connection without the far side
		 * ever learning it should stop, leaving an orphaned server holding the port.
		 *
		 * **A persistent connection has no such obligation, and must not pretend it
		 * does.** Closing the tab means "let go": this closes the tunnel and leaves
		 * the host running, which is the entire point of the mode. `terminate()` is
		 * the one that ends a host, and only an explicit operator action calls it.
		 */
		stop() {
			if (!persistent) endHold()
			closeTunnel()
		},
		/** Let go of the forward and leave the host exactly as it was. */
		detach() {
			closeTunnel()
		},
		/**
		 * End the host as well as the forward.
		 * @returns the stop program's output, for the transcript.
		 */
		terminate() {
			closeTunnel()
			if (!persistent) {
				endHold()
				return Promise.resolve([])
			}
			return stopPersistentHost(device, platform, ssh, onLine, authEnv)
		},
		/**
		 * Fires when the server connection ends on its own.
		 *
		 * A persistent connection has no server connection to watch: its host is
		 * somebody else's process, and the tunnel is the only thing that can end
		 * under it. Callers that reconnect use `onTunnelExit`.
		 */
		onServerExit(listener) {
			if (hold === null) return
			hold.once('exit', (code) => {
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
		 * Whether a process this connection owns is still a live process.
		 *
		 * Asked by a restart, which has to know that what it owns is really gone
		 * before it starts a replacement. `exitCode` is Node's own record of an
		 * ended child, so this cannot disagree with the `exit` events above about
		 * whether something is still there.
		 *
		 * @returns true while the tunnel — or, ephemeral, the hold — has not ended.
		 */
		stillRunning() {
			return (hold !== null && hold.exitCode === null) || tunnel.exitCode === null
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

/**
 * The local Harness is a host, not a child of this application.
 *
 * **Why this is not `connectLocal` with a different teardown.** That function
 * spawns `dsh web` with a pipe as its stdin: on POSIX the server's lifetime is
 * bound to that pipe reaching EOF, which happens the moment this application
 * exits. Skipping `stop()` on quit would therefore still kill it, and on Windows
 * it would survive but leave no record of its port or token — the next Connect
 * would start a second Harness over the same DSH home, which is the state that
 * produces `session/writer-held`. A local host that outlives the window has to
 * be a *detached, recorded* host, and the protocol for exactly that already
 * exists in `remote.js` for persistent machines. Running the same ensure and
 * stop programs on this machine gives the local tab adoption and a durable
 * record without duplicating the protocol.
 *
 * The application therefore does not start it at boot and does not end it at
 * quit. Connect starts or adopts it; Disconnect lets go of it; Stop host is the
 * one explicit action that ends it.
 */

/** The shell family of the machine this application is running on. */
function localFamily() {
	return process.platform === 'win32' ? 'windows' : 'posix'
}

/**
 * Run one host program on this machine.
 *
 * The Windows half reuses `remote.windowsCommand` rather than spelling the
 * PowerShell flags again, so the encoding stays the one the protocol already
 * pins; its encoded argument contains no spaces, so splitting the command is
 * safe. POSIX uses the same interactive login bash as a remote command, for the
 * same reason: `dsh` may only be on PATH after `~/.bashrc` has run.
 *
 * @param program - the ensure or stop program.
 * @returns a command and its argv.
 */
function localHostArgv(program, platform = process.platform) {
	if (platform === 'win32') {
		const parts = remote.windowsCommand(program).split(' ')
		return { command: parts[0], args: parts.slice(1) }
	}
	return { command: 'bash', args: ['-lic', program] }
}

/** The recorded local host, when the record still names a live process. */
function localHostAlive() {
	try {
		const home = process.env.DSH_HOME === undefined || process.env.DSH_HOME === '' ? join(homedir(), '.dsh') : process.env.DSH_HOME
		const record = JSON.parse(readFileSync(join(home, remote.HOST_DIR, remote.HOST_RECORD_FILE), 'utf8'))
		if (!Number.isInteger(record.pid)) return false
		// Signal 0 asks the OS whether the pid exists without sending anything.
		process.kill(record.pid, 0)
		return true
	} catch {
		return false
	}
}

/**
 * End the recorded local host, from an explicit operator action.
 *
 * The program owns the record: it checks the pid is still a Harness, kills it
 * and removes the file. Nothing here infers a port or a pid from this process's
 * memory, because this is also how a host from an earlier run is stopped.
 *
 * @param options - `onLine` for the transcript.
 */
async function stopLocalHost(options = {}) {
	const onLine = typeof options.onLine === 'function' ? options.onLine : () => {}
	const { command, args } = localHostArgv(remote.persistentStopProgram({}, localFamily()))
	const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
	for (const [stream, prefix] of [[child.stdout, ''], [child.stderr, '! ']]) {
		stream?.setEncoding('utf8')
		stream?.on('data', (chunk) => {
			for (const line of String(chunk).split(/\r?\n/u)) {
				if (line.trim() !== '') onLine(prefix + line)
			}
		})
	}
	await new Promise((resolve) => {
		child.once('exit', resolve)
		child.once('error', resolve)
	})
}

/**
 * Start or adopt the local Harness, for the local tab.
 *
 * @param options - `onLine` for the transcript and `onChild` to stop the one-shot
 *   ensure client if the connect is cancelled while it runs.
 * @returns the connection, or `{ error }`.
 */
async function connectLocalPersistent(options = {}) {
	const onLine = typeof options.onLine === 'function' ? options.onLine : () => {}
	const version = await localVersion()
	if (version.problem !== null) {
		onLine(`! ${version.problem}`)
		return { error: version.problem }
	}
	if (version.reported !== null) onLine(`local dsh: ${version.reported}`)
	if (options.signal?.aborted === true) return { error: 'the connect was stopped before it finished' }

	const family = localFamily()
	const { command, args } = localHostArgv(remote.persistentEnsureProgram({}, family))
	onLine(`host program: ${command} <ensure>`)
	const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
	// The ensure program is one-shot. Cancelling kills the *client*, never the
	// host it may already have started — that host belongs to the record now.
	const stopClient = () => {
		try {
			child.kill()
		} catch {
			/* already gone */
		}
	}
	if (typeof options.onChild === 'function') options.onChild(stopClient)
	options.signal?.addEventListener('abort', stopClient, { once: true })
	const ensured = await awaitEnsure(child, onLine, family === 'windows' ? 'powershell' : 'bash')
	if (ensured.error !== undefined) return { error: ensured.error }
	const parsed = remote.parseReadyUrl(ensured.url)
	onLine(ensured.adopted === true ? 'reusing the local host this machine already had' : 'started a local host that outlives this application')
	return {
		url: ensured.url,
		port: parsed.port,
		persistent: true,
		adopted: ensured.adopted === true,
		platform: family,
		// There is no child to end here. Disconnect and quit both let go; only
		// Stop host calls `terminate`, which runs the protocol's stop program.
		stop() {},
		detach() {},
		terminate: () => stopLocalHost({ onLine }),
		stillRunning: () => localHostAlive()
	}
}

/**
 * Pick the address a connect will use.
 *
 * Exported so a terminal — which opens ssh without going through `connectRemote`
 * — makes the same choice by the same rules. The probe is injectable for the
 * offline suites; nothing here runs a network check for a single-address device.
 *
 * @param device - the device record from the book.
 * @param options - `onLine`, `signal`, `probe`, `timeoutMs`.
 * @returns the chosen device and how the answer was reached.
 */
async function resolveAddress(device, options = {}) {
	return addresses.resolve(device, options)
}

/**
 * Stop the host one persistent device is using, without a tab that owns it.
 *
 * The tab has usually let go already — closing a persistent tab drops the tunnel
 * and leaves the host — so "Stop host" has no connection object to ask. This is
 * the same program `terminate()` runs, reached from a device record instead.
 *
 * @param device - the device whose host is being stopped.
 * @param platform - the shell family the far side speaks.
 * @param options - `onLine` for the transcript, and `password`/`askpassDir` when the
 *   device authenticates by password.
 * @returns the stop program's output lines.
 */
async function stopHost(device, platform = 'posix', options = {}) {
	const onLine = typeof options.onLine === 'function' ? options.onLine : () => {}
	// Stop host is reached without a tab, often after the tunnel has gone. It still
	// has to reach the same machine the book now names, by the same selection rules.
	const chosen = await resolveAddress(device, { onLine, probe: options.addressProbe, timeoutMs: options.addressTimeoutMs })
	return stopPersistentHost(chosen.device, platform, sshExecutable(), onLine, authEnvFor(chosen.device, options))
}

module.exports = { sshExecutable, freePort, waitForLocalPort, waitForHttpReady, awaitReady, readableStderr, readyUrl: remote.readyUrl, detectPlatform, resolveAddress, connectRemote, connectLocal, connectLocalPersistent, stopLocalHost, localHostArgv, localHostAlive, stopHost, localVersion, SSH_FAILURE, HTTP_READY_TIMEOUT_MS, APP_MOUNT }
