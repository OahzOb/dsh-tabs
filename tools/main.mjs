/**
 * Drive the real main process against a stubbed Electron shell.
 *
 * The headline feature of this application is that `Alt+1…9` works while the
 * focus is inside a remote interface, and that behaviour lives entirely in
 * `before-input-event` routing in `src/main.js`. Until now it was only asserted
 * by reading the source text, which cannot tell whether a keypress actually
 * selects a tab, whether a modifier is honoured, or whether a tab that has never
 * been up gets started by the shortcut.
 *
 * So the module is loaded for real, with `electron` and `./connect.js` replaced
 * by recording fakes. The tab lifecycle, the shortcut routing and the teardown
 * are then exercised as code.
 *
 * Usage: node tools/main.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const require = createRequire(import.meta.url)

/**
 * Keep this suite away from the operator's real device book.
 *
 * This suite **writes** a device book — `harness()` overwrites it at the start of
 * every test — so pointing it at a real `$DSH_HOME` replaces the operator's
 * devices with test fixtures. The accident is a shell that exports `DSH_HOME` to
 * the real home, which is easy to be in: `node tools/main.mjs` then quietly
 * rewrites the real book. That happened while this suite was being written, and
 * it emptied a book holding two real devices.
 *
 * It redirects rather than refusing, because refusing breaks `npm test` in any
 * such shell — and the suite has no use for the real book, so there is nothing to
 * refuse *for*. One name is treated as reserved: `<home>\.dsh`, which is what
 * `src/devices.js` falls back to when `DSH_HOME` is unset. Anything else is taken
 * at its word, and an explicit `DSH_TABS_TEST_HOME` still wins, so the escape
 * hatch documented in the README keeps working.
 */
function useScratchHome() {
	const target = process.env.DSH_HOME
	if (target === undefined || target.trim() === '') return
	if (resolve(target) !== resolve(join(homedir(), '.dsh')) && resolve(target) !== resolve(homedir())) return
	if (process.env.DSH_TABS_TEST_HOME !== undefined && process.env.DSH_TABS_TEST_HOME.trim() !== '') {
		console.log(`ignoring DSH_HOME=${target}: this suite writes the book it is pointed at`)
		return
	}
	console.log(`ignoring DSH_HOME=${target}: it is the real device book, and this suite writes the book it is pointed at`)
	console.log('  using DSH_TABS_TEST_HOME instead; set it yourself to choose the directory')
	process.env.DSH_TABS_TEST_HOME = join(tmpdir(), 'dsh-tabs-main-test')
}

useScratchHome()

/**
 * A device book inside a scratch directory the real loader reads through
 * `DSH_HOME`.
 *
 * The suite has to create a directory, and some environments refuse that outside
 * their own workspace — the same confinement that makes this application live
 * outside `$DSH_HOME` in the first place. So the candidates are tried in order
 * and the one that worked is reported, rather than one location being assumed and
 * failing as an `EPERM` somewhere unrelated in the middle of a run.
 *
 * `DSH_TABS_TEST_HOME` overrides everything.
 *
 * @returns a writable scratch directory that now exists and is empty.
 */
function scratchHome() {
	const candidates = [process.env.DSH_TABS_TEST_HOME, join(ROOT, '.tmp-main-test'), join(tmpdir(), 'dsh-tabs-main-test')].filter(
		(candidate) => typeof candidate === 'string' && candidate !== ''
	)
	for (const candidate of candidates) {
		try {
			rmSync(candidate, { recursive: true, force: true })
			mkdirSync(candidate, { recursive: true })
			return candidate
		} catch {
			/* try the next candidate */
		}
	}
	throw new Error(`no writable scratch directory; tried:\n  ${candidates.join('\n  ')}`)
}

const HOME = scratchHome()
process.env.DSH_HOME = HOME
// The askpass helper is a real file with an executable bit; a suite must write it
// into its own scratch directory rather than the operator's profile.
process.env.DSH_TABS_ASKPASS_DIR = join(HOME, 'askpass')
console.log(`scratch device book: ${HOME}`)

let passes = 0
const failures = []

/**
 * Wait until a condition holds.
 *
 * A fixed sleep is a race, not a wait. `press` starts an asynchronous chain that
 * reads the device book off disk, and a handful of milliseconds is enough on a
 * warm cache and not enough on a cold one — this suite failed roughly one run in
 * ten that way, which is the worst kind of test, because it teaches you to re-run
 * until it is green instead of reading the failure.
 *
 * @param predicate - resolves true when the wait is over.
 * @param what - what is being waited for, for the failure message.
 * @param timeoutMs - how long to keep trying.
 */
async function waitFor(predicate, what, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		if (await predicate()) return
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
		await new Promise((resolve) => {
			setTimeout(resolve, 10)
		})
	}
}

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
 * Build a fresh main-process harness.
 * @param options - the device book, the connect results to hand out, and the
 *   connections that must be left pending.
 * @returns the harness.
 */
function harness(options = {}) {
	writeFileSync(join(HOME, 'dsh-tabs.json'), `${JSON.stringify({ devices: options.devices ?? [] }, null, 2)}\n`, 'utf8')

	const ipc = new Map()
	const appListeners = new Map()
	const sent = []
	const stops = []
	/** Every folder chooser this harness was asked to show. */
	const dialogCalls = []
	const exits = { server: [], tunnel: [] }
	/**
	 * Every guest session the main process asked to empty, and the order of the
	 * session and connect events it produced.
	 *
	 * The order is the assertion that matters: a clear that happens after the connect
	 * has started would leave the cookie the connect is about to mint, which is the
	 * whole failure. A count cannot see that.
	 */
	const guestClears = []
	const events = []
	/** What the stubbed default session reports, and what was removed from it. */
	const legacyCookies = [...(options.legacyCookies ?? [])]
	const removedCookies = []
	/** Make the stubbed default session's store refuse to be read. */
	const legacyCookieError = options.legacyCookieError === true
	let readyResolve
	const ready = new Promise((resolve) => {
		readyResolve = resolve
	})

	/** Results handed out by the stubbed connect module, in order. */
	const queue = [...(options.connections ?? [])]
	/**
	 * The connect result this test is holding open, if any.
	 *
	 * A box rather than a value because the connect path reads it after the test has
	 * written it, and because consuming it has to be atomic with reading it.
	 *
	 * @type {{value: (ReturnType<typeof heldConnect> & {settle: () => void}) | undefined}}
	 */
	const held = { value: undefined }

	/** Called the instant a connect begins, for tests that need to act inside it. */
	let onConnectStart

	/** The error the next connect throws instead of connecting. */
	let throwNext

	/** The error `whenReady` gives up with, when a test is checking the boot chain. */
	let refuseReady = options.refuseReady
	/** Held until that test lets it go, so the chain's `.catch` is attached first. */
	let refuse
	const refused = new Promise((_resolve, reject) => {
		refuse = reject
	})
	/**
	 * Settled the moment it is asked for, and made to fail before anything awaits it.
	 *
	 * The obvious shape — `whenReady: () => Promise.reject(...)` — cannot work: `main.js`
	 * attaches its `.catch` in a microtask, and this stub is called synchronously, so the
	 * rejection is already recorded as unhandled by the time anything is listening, and
	 * Node's default for that is to terminate the process. The chain is handed a promise
	 * that is settled on the next microtask instead, which is the order the real
	 * `whenReady` has, and which the `.catch` does catch.
	 *
	 * @returns the readiness promise.
	 */
	function whenReady() {
		if (refuseReady === undefined) return ready
		queueMicrotask(() => {
			refuse(new Error(refuseReady))
		})
		return refused
	}
	const line = (text) => text

	/**
	 * Build one connection result.
	 * @param overrides - fields to override.
	 * @returns the result the real `activate` will consume.
	 */
	function ok(overrides = {}) {
		let serverExit
		let tunnelExit
		let stopped = 0
		let detached = 0
		return {
			url: 'http://127.0.0.1:19999/?token=fake',
			platform: 'posix',
			stop() {
				stopped += 1
				stops.push(overrides.url ?? 'http://127.0.0.1:19999/?token=fake')
			},
			/**
			 * Test-only: the persistent half of a teardown.
			 *
			 * A real connection's `stop()` *is* `detach()` for a persistent tab, and the
			 * count is separate so a test can tell "let go" from "torn down" — which is
			 * the only distinction this mode adds.
			 */
			detach() {
				detached += 1
			},
			detachCount: () => detached,
			/** Test-only: how many times this connection was torn down. A count, not a
			 * flag, because the defect this suite is watching for is a *second*
			 * teardown — of a pipe that is already closed, or of a pid that has been
			 * reused — and a boolean cannot see it. */
			stopCount: () => stopped,
			/** Test-only: the real connection answers with its children's `exitCode`s.
			 * Only the restart tests set this — every other case keeps the "there is
			 * nothing left to wait for" answer below and does not pay a bounded wait
			 * for a process that does not exist. */
			stillRunning: () => false,
			onServerExit(listener) {
				serverExit = listener
			},
			onTunnelExit(listener) {
				tunnelExit = listener
			},
			/** Test-only: fire the watcher the way a dying ssh would. */
			crash(code = 255) {
				serverExit?.(code)
			},
			crashTunnel(code = 255) {
				tunnelExit?.(code)
			},
			// Last, so an override of any of the above — `stillRunning` included, which
			// is how a restart test holds a process "alive" — actually wins.
			...overrides
		}
	}

	/**
	 * A connection result that does not settle until the test says so.
	 *
	 * @returns the connection, with `settle` to end the attempt.
	 */
	function heldConnect() {
		const connection = ok()
		let release
		const promise = new Promise((resolve) => {
			release = resolve
		})
		connection.settle = () => {
			release(connection)
		}
		// The stub has to *return* the promise for the connect to stay in flight, and
		// the test needs the connection to call `settle` on — so the promise carries
		// it, and `pending` returns one or the other.
		connection.promise = promise
		return connection
	}

	/**
	 * Hand out the next connect result, registering its teardown as it is handed over.
	 *
	 * **The registration is synchronous with the connect being entered.** The real
	 * `connectRemote` spawns its first ssh client in the synchronous part of the
	 * function — before its own first `await` — and hands the kill over right there,
	 * which is what makes a connect in flight stoppable at all. Handing the kill over
	 * only once the promise settled would put it in a microtask, and a cancel that
	 * arrives before it would find nothing to stop.
	 */
	async function pending(callOptions = {}) {
		callOptions.onLine?.(line('connect fake'))
		// Recorded beside the guest-session clears: "the clear happened before the
		// connect" is the property, and only one ordered log can show it.
		events.push({ kind: 'connect' })
		if (throwNext !== undefined) {
			// What a connect does when the book hands it something the platform refuses:
			// `spawn` throws on the NUL byte in a `host`, and it throws *here*, before it
			// has anything to stop.
			const message = throwNext
			throwNext = undefined
			throw new Error(message)
		}
		const armed = held.value
		held.value = undefined
		const connection = armed ?? queue.shift() ?? heldConnect()
		callOptions.onChild?.(() => {
			connection.stop()
		})
		onConnectStart?.()
		// Settled, not held, unless the test armed one: the default has to be the
		// boring case, or every check in this file would quietly become a test of the
		// in-flight path.
		if (armed !== undefined) return connection.promise
		return connection
	}

	/** The family `detectPlatform` answers when the book has not cached one. */
	const terminalPlatform = 'posix'
	/** The probe failure a test asked for, if any. */
	const detectError = options.detectError

	/**
	 * Every `connectRemote` call this harness saw, with the options it was handed.
	 *
	 * The password a device needs is passed *to the connect*, and it is the one thing
	 * about it that cannot be read back out of the tab state — deliberately, because
	 * the renderer must never be given it again. This is where a test looks instead.
	 *
	 * @type {{device: Record<string, unknown>, options: Record<string, unknown>}[]}
	 */
	const connectCalls = []
	/** Every address resolution a terminal asked for, with what it picked. */
	const addressCalls = []

	const connectStub = {
		sshExecutable: () => 'ssh',
		/**
		 * Address selection is a pure decision; the stub lets a test name the
		 * answer instead of opening sockets to invented hosts.
		 */
		async resolveAddress(device) {
			const host = options.resolveTo ?? device.host
			addressCalls.push({ device, host })
			return { device: { ...device, host }, host, automatic: true, tried: [], unreachable: false }
		},
		async connectLocal(callOptions = {}) {
			return pending(callOptions)
		},
		async connectRemote(device, callOptions = {}) {
			// What the connect path was handed, including the credential — the one
			// property a password device adds, and the one a test has to see without
			// asking the real `connect.js` to spawn anything.
			connectCalls.push({ device, options: callOptions })
			return pending(callOptions)
		},
		/**
		 * The shell-family probe. A terminal asks this before it has a command to
		 * run, and the device book carries the answer afterwards — the real probe is
		 * `ssh` with a deadline, which this suite does not need to repeat.
		 *
		 * @param device - the device being classified.
		 * @returns the family, or the one the suite configured.
		 */
		async detectPlatform(device) {
			if (detectError !== undefined) return { error: detectError }
			return { platform: device.platform ?? terminalPlatform }
		}
	}

	/**
	 * One fake ssh session, in the shape `src/terminal.js` returns.
	 *
	 * The native pty is not in this suite's way: what is being checked here is the
	 * tab's ownership of a session — one start per generation, data routed to the
	 * right tab, input and resize forwarded, kill on close — and the terminal module's
	 * own suite exercises the real buffer and argv.
	 */
	const terminalSpawns = []

	/**
	 * One fake terminal session, in the shape `src/terminal.js` returns.
	 *
	 * A local tab and a device tab hand the module different options — `device` and
	 * `platform` for one, `preset` and `cwd` for the other — but the session the tab
	 * then owns is the same, and this suite is about the tab's ownership of it.
	 *
	 * @param startOptions - what the tab passed in.
	 * @returns the session.
	 */
	function makeTerminalSession(startOptions) {
		const session = {
			pid: 4000 + terminalSpawns.length,
			attached: false,
			ended: false,
			writes: [],
			resizes: [],
			killed: 0,
			held: [],
			attach() {
				if (this.attached) return
				this.attached = true
				const held = this.held.splice(0, this.held.length)
				for (const data of held) startOptions.onData?.(data)
			},
			write(data) {
				this.writes.push(data)
			},
			resize(cols, rows) {
				this.resizes.push([cols, rows])
			},
			kill() {
				this.killed += 1
				this.ended = true
			},
			stillRunning() {
				return !this.ended
			},
			/** Test-only: the far side printed something. */
			emit(data) {
				if (this.attached) startOptions.onData?.(data)
				else this.held.push(data)
			},
			/** Test-only: the process ended. */
			exit(code = 0) {
				this.ended = true
				startOptions.onExit?.({ exitCode: code, signal: undefined })
			},
			startOptions
		}
		terminalSpawns.push(session)
		return session
	}

	const terminalStub = {
		PRESETS: [
			{ id: 'shell', label: 'Shell', command: undefined },
			{ id: 'pi', label: 'pi', command: 'pi' },
			{ id: 'opencode', label: 'opencode', command: 'opencode' }
		],
		start: (startOptions) => makeTerminalSession(startOptions),
		startLocal: (startOptions) => {
			// A real resolution failure throws before a pty exists, and the tab has to
			// show that sentence rather than staying at `starting`.
			if (options.localError !== undefined) throw new Error(options.localError)
			return makeTerminalSession(startOptions)
		},
		listPresets: () => [
			{ id: 'shell', label: 'Shell', available: true },
			{ id: 'pi', label: 'pi', available: true },
			{ id: 'opencode', label: 'opencode', available: true }
		]
	}

	const fakeWindow = {
		webContents: {
			send: (channel, payload) => {
				sent.push([channel, payload])
			},
			on: () => {},
			setWindowOpenHandler: () => {},
			isDestroyed: () => false
		},
		once: () => {},
		on: () => {},
		show: () => {},
		loadFile: () => {},
		isDestroyed: () => false
	}

	const electronStub = {
		app: {
			on(event, listener) {
				const list = appListeners.get(event) ?? []
				list.push(listener)
				appListeners.set(event, list)
			},
			/**
		 * Get ready — or hand back the refusal a test armed, which stays pending until
		 * that test lets it go.
		 */
		whenReady,
			quit: () => {},
			exit: () => {},
			/**
			 * The single-instance lock.
			 *
			 * `options.singleInstance` is what lets a test be the *second* launch. The
			 * real main process registers nothing at all when this is refused, and the
			 * assertions for that case are about what was **not** set up — which is the
			 * entire point of the guard, and invisible to a test that only ever sees the
			 * first instance.
			 */
			requestSingleInstanceLock: () => options.singleInstance !== false
		},
		BrowserWindow: class {
			// Returning an object from a constructor replaces `this`, which is how the
			// real window handle is handed to the module under test.
			constructor() {
				return fakeWindow
			}
			static getAllWindows() {
				return [fakeWindow]
			}
		},
		ipcMain: {
			handle(channel, listener) {
				ipc.set(channel, listener)
			},
			/**
		 * The one-way channels. Kept under a prefix so a test can tell an `invoke`
		 * handler from a `send` one, which is the distinction the terminal's hot
		 * input path relies on.
		 */
			on(channel, listener) {
				ipc.set(`on:${channel}`, listener)
			}
		},
		clipboard: { readText: () => '', writeText: () => {} },
		/**
		 * The folder chooser.
		 *
		 * `options.dialog` is either a result or a function of the arguments, so a test
		 * can answer a specific dialog and inspect the default path it was given. With
		 * no option the operator cancelled, which is where a test that has no opinion
		 * about a chooser should land.
		 */
		dialog: {
			async showOpenDialog(...args) {
				dialogCalls.push(args)
				const answer = typeof options.dialog === 'function' ? await options.dialog(...args) : options.dialog
				if (answer === undefined) return { canceled: true, filePaths: [] }
				if (typeof answer === 'string') return { canceled: false, filePaths: [answer] }
				return answer
			}
		},
		shell: { openExternal: () => {} },
		session: {
			/**
			 * One session per partition name.
			 *
			 * The name is the whole point: a partition without a `persist:` prefix is
			 * in memory, and a persistent one would only move the cookie growth that
			 * caused the blank windows from the window's jar into a per-tab one. A test
			 * that reads the name back out of the state push can see which kind was
			 * asked for.
			 */
			fromPartition(name) {
				return {
					async clearStorageData(filter) {
						guestClears.push({ partition: name, filter })
						events.push({ kind: 'clear', partition: name })
					}
				}
			},
			defaultSession: {
				cookies: {
					async get() {
						if (legacyCookieError) throw new Error('the cookie store could not be read')
						return legacyCookies
					},
					async remove(url, name) {
						removedCookies.push({ url, name })
					}
				}
			}
		}
	}

	// Intercept the two modules the main process reaches for. Everything else —
	// including the real device book and the real normalization — stays real.
	const Module = require('node:module')
	const original = Module._load
	Module._load = function load(request, parent, isMain) {
		if (request === 'electron') return electronStub
		if (request === './connect.js') return connectStub
		if (request === './terminal.js') return terminalStub
		return original.call(this, request, parent, isMain)
	}
	delete require.cache[require.resolve(join(ROOT, 'src', 'main.js'))]
	require(join(ROOT, 'src', 'main.js'))
	Module._load = original

	/**
	 * One web contents, as Electron reports it.
	 *
	 * Listeners are kept per contents rather than in one map, because the whole point
	 * of the guest cases below is that a key can arrive on a *different* contents
	 * than the window's. Returning an object from the constructor replaces `this`.
	 */
	function contents() {
		const listeners = new Map()
		return {
			listeners,
			on(event, listener) {
				listeners.set(event, listener)
			},
			setWindowOpenHandler: () => {},
			/** Fire one of this contents' own events. */
			emit(event, ...args) {
				listeners.get(event)?.(...args)
			},
			/** Press a key into *this* contents, the way Electron reports it. */
			press(overrides = {}) {
				const input = { type: 'keyDown', key: '1', code: 'Digit1', alt: true, control: false, meta: false, shift: false, isAutoRepeat: false, ...overrides }
				let prevented = false
				listeners.get('before-input-event')?.({ preventDefault: () => { prevented = true } }, input)
				return { prevented }
			}
		}
	}

	const windowContents = contents()
	const guestContents = contents()

	return {
		ipc,
		sent,
		stops,
		dialogCalls,
		queue,
		ok,
		pending,
		guestClears,
		events,
		legacyCookies,
		removedCookies,
		connectCalls,
		addressCalls,
		/**
		 * Arm the next connect so it does not settle until the test says so.
		 *
		 * @returns the connection that connect will produce.
		 */
		hold() {
			const connection = heldConnect()
			held.value = connection
			return connection
		},
		/** Be told the instant a connect begins. */
		onConnectStart(listener) {
			onConnectStart = listener
		},
		/** Make the next connect throw, the way `spawn` does on a value it refuses. */
		throwNext(message) {
			throwNext = message
		},
		/**
		 * Make `app.whenReady()` fail, which is the boot chain's other failure.
		 *
		 * An **option to `harness()`**, not a method on it, because `whenReady` is asked
		 * once, synchronously, while `src/main.js` is being loaded: by the time a method
		 * could be called, the answer has already been given.
		 */
		window: windowContents,
		guest: guestContents,
		/**
		 * Press a key into the window's own contents.
		 * @param overrides - fields of the Input object.
		 */
		press(overrides = {}) {
			return windowContents.press(overrides)
		},
		/**
		 * Let the main process finish its asynchronous boot.
		 *
		 * Three waits, because there are three preconditions and none of them is a
		 * duration: the `whenReady` continuation has to install the IPC handlers
		 * before anything can be asked of it, only then can the local tab be watched
		 * until it is genuinely `running`, and the guest arrives *after* that — the
		 * window exists before it navigates anything.
		 *
		 * The guest is attached through `did-attach-webview` rather than through
		 * `web-contents-created`, which is the hook the desktop shell reaches its own
		 * guests through and the one the audit found untested. Emitting only
		 * `web-contents-created` meant every `Alt+digit` check ran against the
		 * window's contents: the case that was never in doubt, and not the one the
		 * README's headline feature rests on.
		 */
		async boot() {
			for (const listener of appListeners.get('web-contents-created') ?? []) listener({}, windowContents)
			readyResolve()
			await waitFor(() => ipc.has('tabs:get'), 'the window to install its IPC handlers')
			await waitFor(async () => {
				const state = await ipc.get('tabs:get')()
				return state.tabs[0]?.state === 'running'
			}, 'the local tab to come up')
			windowContents.emit('did-attach-webview', {}, guestContents)
		},
		/** Emit an app-level event such as `before-quit`. */
		emitApp(event) {
			for (const listener of appListeners.get(event) ?? []) listener()
		},
		state: () => ipc.get('tabs:get')(),
		call: (channel, ...args) => ipc.get(channel)({}, ...args),
		/**
		 * One tab's transcript, as the transcript channel reports it.
		 *
		 * Through the IPC handler rather than through a captured reference: what the
		 * operator can read is the answer that matters, and a restart's own line about
		 * whether the wait succeeded is only worth writing if it arrives there.
		 *
		 * @param id - the tab id.
		 * @returns the transcript as one string.
		 */
		transcriptFor: (id) => ipc.get('devices:transcript')({}, id).lines.join('\n'),
		/** Every terminal session the stubbed terminal module started, in order. */
		terminalSpawns,
		/** Send on a one-way channel, as `ipcRenderer.send` would. */
		send: (channel, ...args) => ipc.get(`on:${channel}`)?.({}, ...args)
	}
}

/**
 * Wait for one connect to be provably in flight, then do something to it.
 *
 * The narrow part of this is the *ordering*, and it is worth stating because the
 * obvious version of each case below does not test what it looks like it tests.
 * `h.state()` is synchronous, and so is `stopTab`: while the tab is `starting` the
 * deferred connect is suspended inside `connect`, and a mode that touches the tab
 * right here arrives inside that window. A mode that `await`s anything at all —
 * even its own return value — throws the window away: microtasks run, the connect
 * resolves, and the tab is `running` with its connection attached by the time the
 * mode gets there. That is the already-covered case wearing the in-flight case's
 * name, which is how the first version of these checks passed nothing on purpose.
 *
 * @param h - the harness.
 * @param id - the tab to watch.
 * @param mode - what to do to the tab at the moment it is in flight; must be synchronous.
 */
async function whileConnecting(h, id, mode) {
	await waitFor(
		() => h.state().tabs.some((tab) => tab.id === id && tab.state === 'starting'),
		`${id} to reach starting (saw ${JSON.stringify(h.state().tabs.map((tab) => `${tab.id}:${tab.state}`))})`
	)
	mode()
}

/**
 * A latch the harness trips when the connect stub is entered.
 *
 * `starting` is not enough to wait on: the tab says that while the attempt is still
 * reading the device book, and a connect that has not been called has nothing to
 * leak. This is the instant the connect has begun — which is also the instant it
 * hands over its first teardown.
 *
 * @returns the latch.
 */
function startedConnect() {
	let resolve
	const promise = new Promise((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

/** Two devices, so the shortcut indices have something to address. */
const book = [
	{ id: 'dev-a', label: 'box-a', transport: 'ssh', host: '10.0.0.2', user: 'deploy', sshPort: 22 },
	{ id: 'dev-b', label: 'box-b', transport: 'ssh', host: '10.0.0.3', user: 'builder', sshPort: 22 }
]

console.log('boot')

await test('the local tab comes up on its own and is first', async () => {
	const h = harness({ devices: book })
	await h.boot()
	const state = await h.state()
	assert.equal(state.tabs[0].id, 'local')
	assert.equal(state.tabs[0].state, 'running')
	assert.equal(state.activeId, 'local')
})

await test('the device book becomes one tab per device, none of them started', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	const state = await h.state()
	assert.deepEqual(state.tabs.map((tab) => tab.id), ['local', 'dev-a', 'dev-b'])
	assert.deepEqual(state.tabs.map((tab) => tab.state), ['running', 'idle', 'idle'])
})

console.log('guest sessions')

await test('every Harness tab has an in-memory session of its own', async () => {
	// **The jar must neither be shared nor persist.** A `dsh web` names its auth
	// cookie after the authority it was reached on, and a browser sends every cookie
	// for the host whatever the port: in one persistent jar those cookies accumulated
	// until the Cookie header crossed the Harness's 16 KiB limit and every guest
	// answered `431`. A session per tab, in memory, is what bounds that.
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	const partitions = (await h.state()).tabs.map((tab) => tab.partition)
	assert.deepEqual(partitions, ['dsh-tabs-guest-local', 'dsh-tabs-guest-dev-a', 'dsh-tabs-guest-dev-b'])
	assert.equal(new Set(partitions).size, partitions.length, 'two tabs share one guest session')
	for (const partition of partitions) {
		assert.equal(String(partition).startsWith('persist:'), false, `a guest session would persist: ${String(partition)}`)
	}
})

await test('a connect empties its tab guest session first, and only its cookies', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	const mark = h.events.length
	await h.call('tabs:activate', 'dev-a')
	const slice = h.events.slice(mark)
	const cleared = slice.findIndex((event) => event.kind === 'clear' && event.partition === 'dsh-tabs-guest-dev-a')
	const connected = slice.findIndex((event) => event.kind === 'connect')
	assert.ok(cleared > -1, 'the guest session was not emptied before the connect')
	assert.ok(connected > -1, 'the connect never started')
	assert.ok(cleared < connected, 'the session was emptied after the connect had started')
	const clear = h.guestClears.find((one) => one.partition === 'dsh-tabs-guest-dev-a')
	assert.deepEqual(clear.filter.storages, ['cookies'], 'a connect wiped more than the session cookies')
})

await test('the window session is cleaned of the cookies earlier builds left', async () => {
	// Before partitions existed every guest ran in the default, persistent session, so
	// that jar still holds one `dsh-auth-*` cookie per Harness ever opened. Nothing
	// reads it now, but leaving 15 KB of them in the profile is how a downgrade — or
	// anything that attaches a guest without a partition — walks back into the 431.
	const h = harness({
		devices: book,
		legacyCookies: [
			{ name: 'dsh-auth-aaa', domain: '127.0.0.1', path: '/', secure: false },
			{ name: 'dsh-auth-bbb', domain: '.127.0.0.1', path: '/deep', secure: false },
			{ name: 'not-ours', domain: '127.0.0.1', path: '/', secure: false }
		]
	})
	await h.boot()
	assert.deepEqual(h.removedCookies.map((entry) => entry.name), ['dsh-auth-aaa', 'dsh-auth-bbb'])
	assert.deepEqual(h.removedCookies.map((entry) => entry.url), ['http://127.0.0.1/', 'http://127.0.0.1/deep'])
})

await test('a cookie store that cannot be read does not stop the local tab', async () => {
	const h = harness({ devices: book, legacyCookieError: true })
	await h.boot()
	assert.equal((await h.state()).tabs[0].state, 'running')
})

console.log('alt+digit')

await test('alt+digit selects a tab without starting it', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	const result = h.press({ code: 'Digit2' })
	assert.equal(result.prevented, true, 'the key was not consumed')
	await waitFor(async () => (await h.state()).activeId === 'dev-a', 'the shortcut to select its tab')
	const state = await h.state()
	assert.equal(state.activeId, 'dev-a')
	// A shortcut is how an operator moves around the bar. Waking the machine it lands
	// on is what the CONNECT panel exists to require instead.
	assert.equal(state.tabs[1].state, 'idle', 'the shortcut started the tab it selected')
	assert.ok(h.sent.some(([channel, payload]) => channel === 'tabs:shortcut' && payload === 'dev-a'))
})

await test('tabs:select shows a tab and starts nothing', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	const selected = await h.call('tabs:select', 'dev-a')
	assert.equal(selected.activeId, 'dev-a')
	assert.equal(selected.tabs.find((tab) => tab.id === 'dev-a').state, 'idle')
})

await test('tabs:activate still starts the tab it is given', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	await h.call('tabs:activate', 'dev-a')
	await waitFor(async () => (await h.state()).tabs[1]?.state === 'running', 'the connect to finish')
	assert.equal((await h.state()).tabs[1].state, 'running')
})

await test('alt+1 goes back to the local tab', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	h.press({ code: 'Digit2' })
	await waitFor(async () => (await h.state()).activeId === 'dev-a', 'the shortcut to select its tab')
	h.press({ code: 'Digit1' })
	assert.equal((await h.state()).activeId, 'local')
})

await test('a digit past the last tab is left alone', async () => {
	// Swallowing a key that selects nothing would break the application
	// underneath for no reason.
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	const result = h.press({ code: 'Digit9' })
	assert.equal(result.prevented, false)
	assert.equal((await h.state()).activeId, 'local')
})

await test('only a bare alt+digit is claimed', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	const cases = [
		{ name: 'ctrl+alt', input: { control: true } },
		{ name: 'alt+shift', input: { shift: true } },
		{ name: 'alt+meta', input: { meta: true } },
		{ name: 'keyUp', input: { type: 'keyUp' } },
		{ name: 'autoRepeat', input: { isAutoRepeat: true } },
		{ name: 'not a digit', input: { code: 'KeyA', key: 'a' } },
		{ name: 'no alt', input: { alt: false } }
	]
	for (const { name, input } of cases) {
		const result = h.press(input)
		assert.equal(result.prevented, false, `${name} was claimed`)
	}
	assert.equal((await h.state()).activeId, 'local')
})

await test('the numpad counts too', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	h.press({ code: 'Numpad2' })
	await waitFor(async () => (await h.state()).activeId === 'dev-a', 'the numpad shortcut to select its tab')
})

await test('alt+digit works from inside a guest, which is the case that matters', async () => {
	// **The headline feature is "Alt+digit while the focus is inside a remote
	// interface", and every check above runs against the window's own contents.**
	// `src/main.js` wires guests through both `web-contents-created` and
	// `did-attach-webview`, and this harness used to emit only the first — so the
	// guest path, the one where a listener in the page could never work, was the
	// only path with no test. Losing `did-attach-webview` would have left the
	// application looking correct here and broken for the operator.
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	// The window's contents is a different object, and it does *not* see this key:
	// that is what makes the assertion below evidence about the guest.
	assert.notEqual(h.guest, h.window)
	const result = h.guest.press({ code: 'Digit2' })
	assert.equal(result.prevented, true, 'the key was not consumed by the guest')
	await waitFor(async () => (await h.state()).activeId === 'dev-a', 'the guest shortcut to select its tab')
	const state = await h.state()
	assert.equal(state.activeId, 'dev-a')
	// A shortcut is how an operator moves around the bar, from wherever the focus
	// happens to be; it is not a request to start the machine it lands on.
	assert.equal(state.tabs[1].state, 'idle', 'a shortcut started the tab it selected')
	assert.ok(
		h.sent.some(([channel, payload]) => channel === 'tabs:shortcut' && payload === 'dev-a'),
		'the renderer was not told which tab won'
	)
})

console.log('failure and teardown')

await test('a connect that fails leaves a reason on the tab', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	h.queue.push({ error: 'the ssh tunnel never began accepting connections' })
	await h.call('tabs:activate', 'dev-a')
	const tab = (await h.state()).tabs[1]
	assert.equal(tab.state, 'failed')
	assert.match(tab.error, /never began accepting connections/u)
	// A failed tab must not keep a URL: the renderer keys guests on it, and a stale
	// one would leave the previous interface on screen under a failure message.
	assert.equal(tab.url, undefined)
})

await test('a server connection that dies later flips the tab to failed', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	const connection = h.ok()
	h.queue.push(connection)
	await h.call('tabs:activate', 'dev-a')
	assert.equal((await h.state()).tabs[1].state, 'running')
	connection.crash(255)
	await waitFor(async () => (await h.state()).tabs[1]?.state === 'failed', 'the dead connection to be noticed')
	const tab = (await h.state()).tabs[1]
	assert.equal(tab.state, 'failed')
	assert.match(tab.error, /server connection ended/u)
	assert.equal(h.stops.length, 1, 'the dead connection was not torn down')
})

await test('disconnecting stops the connection and returns the tab to idle', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	h.queue.push(h.ok())
	await h.call('tabs:activate', 'dev-a')
	await h.call('tabs:disconnect', 'dev-a')
	const tab = (await h.state()).tabs[1]
	assert.equal(tab.state, 'idle')
	assert.equal(tab.url, undefined)
	assert.equal(h.stops.length, 1)
})

await test('a disconnect during a pending connect stops it instead of being a no-op', async () => {
	// **The `×` during `starting` did nothing at all.** `activate` attached the
	// connection to the tab only after every `await`, and `stopTab` stops what is
	// attached, so for the whole of a connect the tab was unstoppable: the operator
	// pressed the control drawn beside a tab that said "starting" and neither the
	// ssh client nor the far side's server was touched. The connect here is held
	// open across the disconnect, which is the state the real one spends seconds in.
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	const connection = h.hold()
	const activating = h.call('tabs:activate', 'dev-a')
	await whileConnecting(h, 'dev-a', () => {
		void h.call('tabs:disconnect', 'dev-a')
	})
	assert.equal((await h.state()).tabs[1].state, 'idle', 'the tab did not stop')
	connection.settle()
	await activating
	// Either the connect's teardown ran, or the connect was refused the moment it
	// started and there was nothing to tear down. Both are "the operator's click
	// counted"; the defect was the third outcome, which is neither, and which the
	// assertions below name.
	assert.ok(connection.stopCount() <= 1, `the connection was torn down ${String(connection.stopCount())} times`)
	assert.equal((await h.state()).tabs[1].state, 'idle', 'the cancelled connect came back up')
	assert.equal((await h.state()).tabs[1].url, undefined, 'the cancelled connect left a URL behind')
	assert.ok(h.stops.length <= 1, `the cancelled connect was stopped ${String(h.stops.length)} times`)
})

await test('a device removed during a pending connect takes its connection with it', async () => {
	// Worse than the no-op above: this one deleted the tab *and* left the attempt
	// running, so the far side kept a server the application could no longer name.
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	const connection = h.hold()
	// Gated on the connect having really begun, and not merely on the tab saying
	// `starting`: the tab says that while its attempt is still reading the device
	// book, and a connect that has not spawned anything has nothing to leak. The
	// case this check exists for is the one where the processes are up.
	const began = startedConnect()
	h.onConnectStart(began.resolve)
	const activating = h.call('tabs:activate', 'dev-a')
	await began.promise
	await h.call('devices:remove', 'dev-a')
	connection.settle()
	await activating
	assert.equal(connection.stopCount(), 1, 'the removed device left its connect running')
	assert.deepEqual((await h.state()).tabs.map((tab) => tab.id), ['local', 'dev-b'], 'the removed tab is still in the bar')
})

await test('quitting tears down a connect that has not finished', async () => {
	// The quit path walks `tabs` and stops what it finds. A connect in flight was
	// not attached to anything yet, so it was not found, and the application exited
	// while two ssh clients and the far side's server were still up.
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	const connection = h.hold()
	const began = startedConnect()
	h.onConnectStart(began.resolve)
	const activating = h.call('tabs:activate', 'dev-a')
	await began.promise
	h.emitApp('before-quit')
	// The local tab, which is up, plus the connect that was in flight.
	assert.equal(connection.stopCount(), 1, 'quitting left the connect in flight running')
	assert.equal(h.stops.length, 2, `expected the local tab and the pending connect, saw ${String(h.stops.length)}`)
	connection.settle()
	await activating
})

await test('a connect that throws becomes a failure the operator can see and retry', async () => {
	// **Nothing contained a throw in the connect path**, and the trigger is reachable
	// from the hand-editable book: `devices.normalize` keeps a NUL byte in `host`, and
	// `spawn` throws `ERR_INVALID_ARG_VALUE` on it. Measured before the fix, with the
	// stub made to throw exactly as `spawn` does: the rejection went to whichever caller
	// happened to be awaiting, so the tab stayed `starting` with no error and a second
	// click did nothing — the one state this application can reach with no way out of
	// it. (The audit's probe saw the other half of the same defect: unhandled, the
	// rejection terminates the process outright.)
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	h.throwNext("The argument 'args[0]' must be a string without null bytes")
	await h.call('tabs:activate', 'dev-a')
	const tab = (await h.state()).tabs[1]
	assert.equal(tab.state, 'failed', 'a throw left the tab in a state with no way out')
	assert.match(tab.error, /without null bytes/u, 'the reason was dropped')
	// The panel draws `tab.error`, and the transcript is behind it — so the failure has
	// to be on the tab, not only on the terminal.
	const { lines } = await h.call('devices:transcript', 'dev-a')
	assert.ok(
		lines.some((line) => line.includes('FAILED:') && line.includes('without null bytes')),
		`the failure is not in the transcript: ${JSON.stringify(lines)}`
	)
	// And it is a state the operator can leave: the next click tries again instead of
	// being refused as "already starting".
	await h.call('tabs:activate', 'dev-a')
	assert.equal((await h.state()).tabs[1].state, 'running', 'the tab could not be retried')
})

await test('a failed connect that had handed over a teardown still runs it', async () => {
	// The real connect registers each child's stop through `onChild` the moment it
	// spawns it, so even a connect that ends in `{ error }` may have handed over a
	// teardown for something that is still running. Before the failure branch ran
	// `cancelAttempt`, a connect that threw *after* the server ssh was spawned left
	// the ssh client and the far side's `dsh web` alive with no tab holding them.
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	let stopped = 0
	h.queue.push({
		error: 'the ssh tunnel never began accepting connections',
		stop() {
			stopped += 1
		}
	})
	const state = await h.call('tabs:activate', 'dev-b')
	assert.equal(state.tabs.find((tab) => tab.id === 'dev-b')?.state, 'failed', 'the failure was not recorded')
	assert.equal(stopped, 1, 'the failed connect left the child it had handed over running')
})

await test('a rejection above the connect does not end the process silently', async () => {
	// **`void app.whenReady().then(async () => { … })` had no `.catch`.** Node's default
	// for a rejection nobody handles is to terminate, so anything thrown in the boot
	// continuation — `createWindow`, `activate`, and the two calls that used to sit
	// beside them — killed the application before it had drawn anything, with no window
	// and no message. (The audit's probe reached it by making the port allocator throw:
	// `Error: freePort exploded` → exit code 1.)
	//
	// The failure is injected rather than caused by breaking something inside, because
	// the chain has to survive a throw from *anywhere* above it. What makes the recovery
	// observable at all is that `installIpc()` and `ensureLocal()` are **not** inside the
	// chain: with them in there, a rejected `whenReady` meant no IPC handlers and no local
	// tab, so the `.catch` could only print a line and the screen stayed empty.
	const unhandled = []
	const listener = (reason) => unhandled.push(reason)
	process.on('unhandledRejection', listener)
	try {
		const h = harness({ devices: book, refuseReady: 'freePort exploded' })
		// Before `whenReady` has resolved, which is the whole point: the two calls that
		// make a failure reportable must not be waiting on the thing that failed.
		const early = await h.call('tabs:get')
		assert.ok(early.tabs.some((tab) => tab.id === 'local'), 'no local tab exists to record a boot failure on')
		await waitFor(async () => {
			const state = await h.call('tabs:get')
			return /freePort exploded/u.test(state.tabs[0]?.error ?? '')
		}, 'the boot failure to be recorded on the local tab')
		const local = (await h.call('tabs:get')).tabs[0]
		assert.equal(local.state, 'failed')
		assert.match(local.error, /could not finish starting/u, 'the failure was recorded as something else')
		// Give the microtask queue room to deliver an unhandled rejection, so the absence
		// of one means something.
		await new Promise((resolve) => {
			setTimeout(resolve, 25)
		})
		assert.deepEqual(unhandled, [], `a rejection escaped the chain: ${unhandled.map(String).join(', ')}`)
	} finally {
		process.off('unhandledRejection', listener)
	}
})

await test('the local tab cannot be disconnected out from under the operator', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('tabs:disconnect', 'local')
	assert.equal((await h.state()).tabs[0].state, 'running')
	assert.equal(h.stops.length, 0)
})

await test('quitting tears down every tab that is up', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	h.queue.push(h.ok())
	await h.call('tabs:activate', 'dev-a')
	h.emitApp('before-quit')
	// local plus dev-a.
	assert.equal(h.stops.length, 2, `expected two stops, saw ${String(h.stops.length)}`)
})

console.log('password auth')

/** A device whose account authenticates by password, which the record now says. */
const passwordBook = [{ ...book[0], id: 'dev-p', label: 'box-p', auth: 'password' }]

await test('a password device asks before it connects, and starts nothing', async () => {
	const h = harness({ devices: passwordBook })
	await h.boot()
	// A device tab exists only once the popover has asked for the book, which is what
	// the renderer does at boot; without the tab there is nothing to activate.
	await h.call('devices:list')
	const result = await h.call('tabs:activate', 'dev-p')
	assert.equal(result.needsPassword.id, 'dev-p')
	assert.equal(result.needsPassword.user, 'deploy')
	assert.equal(result.needsPassword.error, undefined)
	// The tab has not been left `starting`: there is no connect to wait for, so the
	// only honest state is the one that offers the button again.
	assert.equal(result.tabs.find((entry) => entry.id === 'dev-p').state, 'idle')
	assert.equal(h.connectCalls.length, 0, 'a connect was attempted with no password')
})

await test('the typed password reaches the connect and is never pushed back to the page', async () => {
	const h = harness({ devices: passwordBook })
	await h.boot()
	await h.call('devices:list')
	const result = await h.call('tabs:activate', 'dev-p', 'correct horse')
	assert.equal(result.needsPassword, undefined)
	assert.equal(h.connectCalls.length, 1)
	assert.equal(h.connectCalls[0].options.password, 'correct horse')
	assert.equal(typeof h.connectCalls[0].options.askpassDir, 'string')
	assert.equal(JSON.stringify(result).includes('correct horse'), false, 'the password was pushed back to the renderer')
	// A restart this run reuses it rather than asking a second time.
	h.queue.push(h.ok())
	await h.call('tabs:restart', 'dev-p')
	assert.equal(h.connectCalls.length, 2)
	assert.equal(h.connectCalls[1].options.password, 'correct horse')
	assert.equal((await h.state()).tabs.find((entry) => entry.id === 'dev-p').state, 'running')
})

await test('a refused password is forgotten, and the next attempt asks instead of replaying it', async () => {
	const h = harness({ devices: passwordBook })
	await h.boot()
	await h.call('devices:list')
	h.queue.push({ error: 'deploy@10.0.0.2: Permission denied (password).' })
	const refused = await h.call('tabs:activate', 'dev-p', 'wrong')
	assert.equal(refused.needsPassword.id, 'dev-p')
	assert.match(refused.needsPassword.error, /Permission denied/u)
	assert.equal(refused.tabs.find((entry) => entry.id === 'dev-p').state, 'failed')
	const next = await h.call('tabs:activate', 'dev-p')
	assert.equal(next.needsPassword.id, 'dev-p')
	assert.equal(h.connectCalls.length, 1, 'the refused password was replayed')
})

await test('a network failure does not throw a good password away', async () => {
	const h = harness({ devices: passwordBook })
	await h.boot()
	await h.call('devices:list')
	h.queue.push({ error: 'ssh: connect to host 10.0.0.2 port 22: Connection timed out' })
	const failed = await h.call('tabs:activate', 'dev-p', 'secret')
	assert.equal(failed.needsPassword, undefined, 'a timeout was treated as a refused password')
	h.queue.push(h.ok())
	const retried = await h.call('tabs:activate', 'dev-p')
	assert.equal(retried.needsPassword, undefined)
	assert.equal(h.connectCalls.length, 2)
	assert.equal(h.connectCalls[1].options.password, 'secret')
})

await test('a terminal on a password device asks for the same password', async () => {
	const h = harness({ devices: passwordBook })
	await h.boot()
	const asked = await h.call('terminal:open', 'dev-p')
	assert.equal(asked.needsPassword.id, 'dev-p')
	const started = await h.call('terminal:open', 'dev-p', 'secret')
	assert.equal(started.needsPassword, undefined)
	assert.equal(h.terminalSpawns.length, 1)
	assert.equal(h.terminalSpawns[0].startOptions.password, 'secret')
})

console.log('persistent hosts')

/** The one device shape this section needs: a persistent host on a fixed local port. */
const persistentBook = [{ ...book[0], mode: 'persistent', localPort: 41777 }]

await test('closing a persistent tab lets go of the tunnel and keeps the host', async () => {
	const h = harness({ devices: persistentBook })
	await h.boot()
	await h.call('devices:list')
	const connection = h.ok({ persistent: true, adopted: true, localPort: 41777 })
	h.queue.push(connection)
	await h.call('tabs:activate', 'dev-a')
	const running = (await h.state()).tabs.find((tab) => tab.id === 'dev-a')
	assert.equal(running.state, 'running')
	assert.equal(running.persistent, true)
	assert.equal(running.url, connection.url)
	await h.call('tabs:disconnect', 'dev-a')
	const detached = (await h.state()).tabs.find((tab) => tab.id === 'dev-a')
	// The whole mode in three assertions: the page and its URL stay, the tab says it
	// is detached rather than idle, and the far-side process was never torn down.
	assert.equal(detached.state, 'detached')
	assert.equal(detached.url, connection.url)
	assert.equal(detached.persistent, true)
	assert.equal(connection.stopCount(), 0, 'a plain close tore the host down')
	assert.equal(connection.detachCount(), 1, 'the tunnel was not let go')
})

await test('quitting detaches a persistent tab instead of killing its host', async () => {
	const h = harness({ devices: persistentBook })
	await h.boot()
	await h.call('devices:list')
	const connection = h.ok({ persistent: true, localPort: 41777 })
	h.queue.push(connection)
	await h.call('tabs:activate', 'dev-a')
	h.emitApp('before-quit')
	assert.equal(connection.detachCount(), 1, 'quitting did not let go of the tunnel')
	assert.equal(connection.stopCount(), 0, 'quitting killed a host that was meant to outlive it')
})

await test('a persistent tab survives losing its tunnel and comes back on its own', async () => {
	const h = harness({ devices: persistentBook })
	await h.boot()
	await h.call('devices:list')
	const first = h.ok({ persistent: true, localPort: 41777 })
	h.queue.push(first)
	await h.call('tabs:activate', 'dev-a')
	first.crashTunnel(255)
	let tab = (await h.state()).tabs.find((entry) => entry.id === 'dev-a')
	// A lost tunnel is not a lost host: the tab says so, keeps the page, and does not
	// claim a failure the operator would have to read as one.
	assert.equal(tab.state, 'detached')
	assert.equal(tab.url, first.url)
	assert.equal(tab.error, undefined)
	// And the retry is a retry, not the end of the story.
	const second = h.ok({ persistent: true, localPort: 41777 })
	h.queue.push(second)
	await new Promise((resolve) => setTimeout(resolve, 1_400))
	tab = (await h.state()).tabs.find((entry) => entry.id === 'dev-a')
	assert.equal(tab.state, 'running', 'the tab never came back')
	assert.equal(tab.url, second.url)
})

await test('Stop host ends a persistent host, and only that control does', async () => {
	const h = harness({ devices: persistentBook })
	await h.boot()
	await h.call('devices:list')
	let terminated = 0
	const connection = h.ok({
		persistent: true,
		localPort: 41777,
		terminate: async () => {
			terminated += 1
			return ['HOST stopped pid=1']
		}
	})
	h.queue.push(connection)
	await h.call('tabs:activate', 'dev-a')
	await h.call('tabs:reap', 'dev-a')
	const tab = (await h.state()).tabs.find((entry) => entry.id === 'dev-a')
	assert.equal(terminated, 1, 'reap did not end the host')
	assert.equal(tab.state, 'idle')
	assert.equal(tab.url, undefined)
	assert.equal(tab.persistent, undefined)
})

console.log('restart')

await test('restarting the local tab replaces the Harness instead of closing the application', async () => {
	// The operation that used to require quitting the whole application, and the one
	// that leaves a stale process behind when the quit does not go cleanly. Both
	// halves are asserted: the old connection is torn down exactly once, and the tab
	// comes back up on a *new* connection rather than the old one.
	const h = harness({ devices: book })
	await h.boot()
	const first = (await h.state()).tabs[0]
	assert.equal(first.state, 'running')
	h.queue.push(h.ok({ url: 'http://127.0.0.1:20001/' }))
	await h.call('tabs:restart', 'local')
	const after = (await h.state()).tabs[0]
	assert.equal(after.state, 'running')
	assert.equal(after.url, 'http://127.0.0.1:20001/', 'the tab is still on the connection it was told to replace')
	assert.equal(h.stops.length, 1, `the old connection was torn down ${String(h.stops.length)} times`)
})

await test('a restart connects nothing until the old process has actually gone', async () => {
	// **Starting the replacement first makes "restart" indistinguishable from doing
	// nothing**: the operator's next turn is served by the process they asked to
	// replace, and the only evidence is a tab that says "running" either way.
	//
	// The old process is held alive for a real span and then released, and the whole
	// span is watched rather than slept through: the replacement connect resolves in
	// one microtask, so a tab observed in any state a *new* connection produces —
	// `starting` with a URL, or `running` — before the release is the defect. Polling
	// the state instead of sleeping a fixed span is what keeps this honest: a fixed
	// sleep only proves the implementation was slower than the sleep.
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	h.queue.push(h.ok())
	await h.call('tabs:activate', 'dev-a')
	const held = { until: Date.now() + 600 }
	const dying = h.ok({
		url: 'http://127.0.0.1:27777/?dying=1',
		stillRunning: () => Date.now() < held.until
	})
	h.queue.push(dying)

	const restarting = h.call('tabs:restart', 'dev-a')
	const watchUntil = Date.now() + 3000
	let early = null
	let sawRunning = false
	while (Date.now() < watchUntil && early === null && !sawRunning) {
		const tab = (await h.state()).tabs[1]
		if (tab.state === 'running') {
			// The release has happened, so this is the replacement arriving — which is
			// the outcome, not the defect. The defect is only a replacement that
			// arrived *while* the old process was alive.
			sawRunning = Date.now() >= held.until
			if (sawRunning) break
		}
		if (tab.state === 'starting' && tab.url !== undefined) early = 'starting with a URL'
		await new Promise((resolve) => {
			setTimeout(resolve, 25)
		})
	}

	assert.equal(early, null, `the replacement appeared while the old process was alive (${String(early)})`)
	assert.ok(sawRunning, 'the tab never came back up after the old process went away')
	held.until = 0
	await restarting
	assert.equal((await h.state()).tabs[1].url, dying.url, 'the tab came back on something other than the replacement')
})

await test('a restart whose process is already gone does not pay the interval', async () => {
	// The other side of the same wait, and the one every ordinary restart is: a
	// Harness that died inside the stop must cost one event-loop turn, not one poll
	// interval — otherwise every restart of a healthy Harness is a tab that says
	// "starting" for no reason, which is what makes an operator press again.
	const h = harness({ devices: book })
	await h.boot()
	const started = Date.now()
	await h.call('tabs:restart', 'local')
	assert.equal((await h.state()).tabs[0].state, 'running')
	assert.ok(Date.now() - started < 250, `a restart of a healthy Harness took ${String(Date.now() - started)}ms`)
})

await test('a restart that cannot be waited out still starts, and says so', async () => {
	// The bounded wait has to fail open. A teardown that never settles would
	// otherwise leave the tab down with no way back but a relaunch, which is the one
	// thing this feature exists to remove — and the operator has to be able to tell
	// this restart from a clean one.
	//
	// The connection the tab is *on* is the stubborn one: that is the process the
	// restart is waiting for, and an implementation that read liveness off the wrong
	// connection would pass this check while never waiting at all.
	//
	// The ceiling is reached for real here, so this is one of the few checks in the
	// file that spends seconds rather than microseconds. That is the point: an
	// implementation whose deadline never fires is a tab that never comes back, and
	// nothing cheaper than waiting can tell the two apart.
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	h.queue.push(h.ok({ stillRunning: () => true }))
	await h.call('tabs:activate', 'dev-a')
	// The replacement is healthy, so the only wait in this test is the ceiling.
	h.queue.push(h.ok({ url: 'http://127.0.0.1:20002/' }))
	const started = Date.now()
	await h.call('tabs:restart', 'dev-a')
	assert.ok(Date.now() - started >= 5_000, 'the ceiling was not reached, so nothing was actually waited for')
	const tab = (await h.state()).tabs[1]
	assert.equal(tab.state, 'running', 'the tab was left down by a teardown that never settled')
	assert.match(h.transcriptFor('dev-a'), /still alive after 5s; started anyway/u)
})

await test('restarting a tab that is down starts it, without a wait', async () => {
	// A failed tab is the case an operator reaches for this in. There is no process
	// to wait for, so it must behave as a plain start — and it must not spend the
	// ceiling doing it.
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	h.throwNext('spawn refused the argument')
	await h.call('tabs:activate', 'dev-a')
	assert.equal((await h.state()).tabs[1].state, 'failed')
	h.queue.push(h.ok({ url: 'http://127.0.0.1:20003/' }))
	const started = Date.now()
	await h.call('tabs:restart', 'dev-a')
	assert.equal((await h.state()).tabs[1].state, 'running')
	assert.ok(Date.now() - started < 1_000, 'a tab with nothing to stop waited for a teardown anyway')
})

console.log('one instance')

await test('a second launch starts no window, no local tab and no Harness', async () => {
	// **The half of "closing the desktop does not close the web process" that has
	// nothing to do with quitting.** A packaged binary answers no version flag of its
	// own, so `dsh-tabs.exe --version` used to come up as a second copy — another
	// window and another `dsh web` — and closing the window the operator was looking
	// at left that one running. Refusing the lock has to leave *nothing* registered,
	// because anything registered would start the duplicate on the way out.
	const h = harness({ devices: book, singleInstance: false })
	assert.equal(h.ipc.size, 0, `a losing instance registered IPC: ${[...h.ipc.keys()].join(', ')}`)
	assert.deepEqual(h.sent, [], 'a losing instance drew something')
	// And the answer to `--version` is the other way out of that binary, so the two
	// are checked together: a version flag must never reach the lock at all.
	const source = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8')
	assert.ok(
		source.indexOf('const answer = launchAnswer(') < source.indexOf('app.requestSingleInstanceLock()'),
		'the version answer is decided after the lock, so a probe could still be a second instance'
	)
})

await test('a first launch does everything the losing one refused to', async () => {
	const h = harness({ devices: book })
	await h.boot()
	assert.ok(h.ipc.has('tabs:restart'), 'the restart channel was never installed')
	assert.equal((await h.state()).tabs[0].state, 'running')
})

console.log('the device book')

await test('saving a device without a host is refused', async () => {
	const h = harness({ devices: [] })
	await h.boot()
	await assert.rejects(() => h.call('devices:save', { label: 'x', user: 'u' }), /host and user are required/u)
})

await test('saving a device with a directory no shell can be given is refused', async () => {
	// The IPC boundary is where an untrusted value enters the book, and the book is
	// what feeds a launch directory into a shell program. A value that cannot be
	// placed there is a typo or an attack; either way it must not be stored, and the
	// operator has to see why. `connect.js` checks the same thing again for a book
	// that was edited by hand, so neither check alone is the guarantee — this pins
	// the one an operator can actually reach.
	const h = harness({ devices: [] })
	await h.boot()
	for (const directory of ['~/work" & calc.exe & "', 'C:\\work%USERPROFILE%', '/srv/dsh|whoami']) {
		await assert.rejects(
			() => h.call('devices:save', { id: 'dev-x', label: 'x', host: 'h', user: 'u', directory }),
			/cannot be passed to a shell safely/u,
			`${directory} was saved`
		)
	}
	// Refused means not stored — a rejected save that still wrote the record would
	// leave the bad value to be picked up by the next launch.
	assert.deepEqual((await h.call('devices:list')).devices, [])
	// And the shapes the field is actually for still save.
	await h.call('devices:save', { id: 'dev-ok', label: 'ok', host: 'h', user: 'u', directory: 'C:\\work\\dsh' })
	assert.equal((await h.call('devices:list')).devices[0].directory, 'C:\\work\\dsh')
})

await test('saving adds the device and its tab', async () => {
	const h = harness({ devices: [] })
	await h.boot()
	await h.call('devices:save', { id: 'dev-z', label: 'new', host: 'h', user: 'u', sshPort: '2222' })
	const state = await h.state()
	assert.deepEqual(state.tabs.map((tab) => tab.id), ['local', 'dev-z'])
	const devices = (await h.call('devices:list')).devices
	assert.equal(devices[0].sshPort, 2222)
})

await test('saving a port that is not a port is refused, not rounded to 22', async () => {
	// `Number(incoming.sshPort) || 22` made every one of these 22 by accident, and
	// `-5` reached `ssh -p -5` because `Number` accepts it. The neighbouring
	// `directory` field is refused at save time for the same class of reason: the
	// operator has to hear about it while the field is still in front of them.
	const h = harness({ devices: [] })
	await h.boot()
	for (const sshPort of ['2222x', '-5', '0', '70000', '22.5']) {
		await assert.rejects(
			() => h.call('devices:save', { id: 'dev-p', label: 'p', host: 'h', user: 'u', sshPort }),
			/whole number between 1 and 65535/u,
			`${sshPort} was accepted as a port`
		)
	}
	// Refused means not stored.
	assert.deepEqual((await h.call('devices:list')).devices, [])
	// And the shapes the field is actually for still save.
	await h.call('devices:save', { id: 'dev-ok', label: 'ok', host: 'h', user: 'u', sshPort: '2222' })
	assert.equal((await h.call('devices:list')).devices[0].sshPort, 2222)
	await h.call('devices:save', { id: 'dev-empty', label: 'empty', host: 'h', user: 'u', sshPort: '' })
	assert.equal((await h.call('devices:list')).devices[1].sshPort, 22)
})

await test('a device cannot take the id this application\'s own tab uses', async () => {
	// A hand-edited book could carry `id: "local"`, and `tabFor` keys the tab map by
	// id: the device *became* the local tab, relabelled it, and `devices:remove`
	// then deleted it and tore the local Harness down for the rest of the session.
	const h = harness({ devices: [] })
	await h.boot()
	await assert.rejects(
		() => h.call('devices:save', { id: 'local', label: 'not-the-local-tab', host: 'h', user: 'u' }),
		/id "local"/u
	)
	assert.equal((await h.state()).tabs[0].label, 'Local', 'the local tab was relabelled')
	// Refused means the device is not in the book and nothing was stopped.
	assert.deepEqual((await h.call('devices:list')).devices, [])
	assert.equal(h.stops.length, 0, 'the local Harness was stopped')
	// And the same removal through the IPC boundary is a no-op rather than a
	// teardown: the id is refused at the door it arrives through.
	const after = await h.call('devices:remove', 'local')
	assert.deepEqual(after.devices, [])
	assert.deepEqual((await h.state()).tabs.map((tab) => tab.id), ['local'])
	assert.equal((await h.state()).tabs[0].state, 'running', 'the local tab was torn down by a removal')
	assert.equal(h.stops.length, 0)
})

await test('a book with a reserved or duplicate id loses the record and says why', async () => {
	// The same rule, reached the other way: the file, not the popover. These records
	// are dropped rather than loaded, and the reason has to survive to the operator —
	// the device is simply absent from the list otherwise, and the file is one they
	// are invited to edit.
	const h = harness({
		devices: [
			{ id: 'local', label: 'not-the-local-tab', transport: 'ssh', host: '10.0.0.3', user: 'u', sshPort: 22 },
			{ id: 'dup', label: 'first', transport: 'ssh', host: '10.0.0.2', user: 'u', sshPort: 22 },
			{ id: 'dup', label: 'second', transport: 'ssh', host: '10.0.0.3', user: 'u', sshPort: 22 }
		]
	})
	await h.boot()
	const listed = await h.call('devices:list')
	assert.deepEqual(
		listed.devices.map((device) => device.label),
		['first'],
		`the book was loaded as written: ${JSON.stringify(listed.devices)}`
	)
	assert.deepEqual(
		(await h.state()).tabs.map((tab) => `${tab.id}:${tab.label}`),
		['local:Local', 'dup:first'],
		'the local tab was overwritten, or two records collapsed into one'
	)
	assert.equal(listed.problems.length, 2, `expected two explanations, saw ${JSON.stringify(listed.problems)}`)
	assert.match(listed.problems.join('\n'), /cannot use the id "local"/u)
	assert.match(listed.problems.join('\n'), /already uses the id "dup"/u)
	// The message names the device, because "a device" is not enough to find it in a
	// file written by hand.
	assert.match(listed.problems.join('\n'), /not-the-local-tab/u)
	// And the file on disk no longer holds the records that were refused, so the
	// message is not repeated on every launch.
	const onDisk = JSON.parse(readFileSync(join(HOME, 'dsh-tabs.json'), 'utf8'))
	assert.deepEqual(onDisk.devices.map((device) => device.id), ['dup'])
})

await test('a book with a port that is not a port loses the record and says why', async () => {
	const h = harness({
		devices: [
			{ id: 'good', label: 'good', transport: 'ssh', host: '10.0.0.2', user: 'u', sshPort: '2222' },
			{ id: 'bad', label: 'bad-port', transport: 'ssh', host: '10.0.0.3', user: 'u', sshPort: '2222x' }
		]
	})
	await h.boot()
	const listed = await h.call('devices:list')
	assert.deepEqual(listed.devices.map((device) => device.id), ['good'])
	// The stored shape is a number, which is what `ssh -p` is handed.
	assert.equal(listed.devices[0].sshPort, 2222)
	assert.match(listed.problems.join('\n'), /bad-port/u)
	assert.match(listed.problems.join('\n'), /whole number between 1 and 65535/u)
})

await test('removing a device takes its tab with it', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	await h.call('devices:remove', 'dev-a')
	const state = await h.state()
	assert.deepEqual(state.tabs.map((tab) => tab.id), ['local', 'dev-b'])
	assert.equal(state.activeId, 'local')
})

await test('a removed device falls back to local when it was active', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	h.press({ code: 'Digit2' })
	await waitFor(async () => (await h.state()).activeId === 'dev-a', 'the shortcut to select its tab')
	await h.call('devices:remove', 'dev-a')
	assert.equal((await h.state()).activeId, 'local')
})

await test('the transcript is readable for a tab that failed', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	h.queue.push({ error: 'ssh: connect to host 10.0.0.3 port 22: Connection timed out' })
	// Awaited, and then asserted on. `tabs:activate` reads the device book from disk
	// before it reaches the connect call, so reading the transcript on the next line
	// raced it and the assertion was handed an empty array — a check that passed or
	// failed with the temperature of the file cache. The state assertion keeps that
	// honest: an empty transcript now fails here, naming the tab and its state,
	// instead of surfacing as a missing line further down.
	const activated = await h.call('tabs:activate', 'dev-b')
	assert.equal(activated.tabs.find((tab) => tab.id === 'dev-b')?.state, 'failed', `the tab did not reach a failed state: ${JSON.stringify(activated)}`)
	const { lines } = await h.call('devices:transcript', 'dev-b')
	assert.ok(lines.some((line) => line.includes('FAILED: ssh: connect to host')), `the reason is not in the transcript: ${JSON.stringify(lines)}`)
})

console.log('terminals')

await test('a terminal opens as its own tab and starts exactly one session', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	const state = await h.call('terminal:open', 'dev-a')
	const tab = state.tabs.find((entry) => entry.id === 'terminal:dev-a')
	assert.ok(tab !== undefined, `no terminal tab: ${JSON.stringify(state.tabs)}`)
	assert.equal(tab.kind, 'terminal')
	assert.equal(tab.label, 'box-a — terminal')
	assert.equal(tab.state, 'running')
	assert.equal(tab.generation, 1)
	assert.equal(state.activeId, 'terminal:dev-a')
	assert.equal(h.terminalSpawns.length, 1, 'the tab started more than one session')
	assert.equal(h.terminalSpawns[0].startOptions.device.id, 'dev-a')
	// This book has no cached family, so the start asked the probe, and the answer
	// was written back: the next terminal on this device must not probe again.
	assert.equal(h.terminalSpawns[0].startOptions.platform, 'posix')
	const listed = await h.call('devices:list')
	assert.equal(listed.devices.find((device) => device.id === 'dev-a').platform, 'posix')
})

await test('a terminal opens through the address the book selected', async () => {
	// The terminal path opens ssh itself, so it must ask the same resolver the
	// connect path uses — otherwise it would reach a different machine than the
	// Harness tab beside it.
	const h = harness({
		devices: [
			{ id: 'dev-a', label: 'box-a', transport: 'ssh', host: '10.0.0.2', user: 'deploy', sshPort: 22, addresses: [{ host: '10.0.0.3' }] }
		],
		resolveTo: '10.0.0.3'
	})
	await h.boot()
	await h.call('devices:list')
	await h.call('terminal:open', 'dev-a')
	assert.equal(h.addressCalls.length, 1, 'the terminal did not choose an address')
	assert.equal(h.addressCalls[0].device.host, '10.0.0.2')
	assert.equal(h.terminalSpawns.length, 1)
	assert.equal(h.terminalSpawns[0].startOptions.device.host, '10.0.0.3')
})

await test('output is held until the renderer attaches, then routed to that tab', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	await h.call('terminal:open', 'dev-a')
	const session = h.terminalSpawns[0]
	session.emit('box-a$ ')
	const dataBefore = h.sent.filter(([channel]) => channel === 'terminal:data')
	assert.equal(dataBefore.length, 0, 'the prompt was sent before a screen existed to draw it on')

	await h.call('terminal:attach', 'terminal:dev-a')
	assert.equal(session.attached, true, 'attach did not reach the session')
	assert.deepEqual(
		h.sent.filter(([channel]) => channel === 'terminal:data').map(([, payload]) => payload),
		[{ id: 'terminal:dev-a', data: 'box-a$ ' }],
		'the buffered prompt was not released in order'
	)

	h.send('terminal:input', 'terminal:dev-a', 'ls\r')
	h.send('terminal:resize', 'terminal:dev-a', 120, 30)
	assert.deepEqual(session.writes, ['ls\r'])
	assert.deepEqual(session.resizes, [[120, 30]])
	// The channels are keyed by tab: input addressed to a Harness tab must not reach
	// the pty, or a renderer bug would type into somebody's shell.
	h.send('terminal:input', 'dev-a', 'rm -rf /\r')
	h.send('terminal:resize', 'dev-a', 1, 1)
	assert.deepEqual(session.writes, ['ls\r'])
	assert.deepEqual(session.resizes, [[120, 30]])
})

await test('a session that ends keeps its tab, and reconnecting starts a new generation', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	await h.call('terminal:open', 'dev-a')
	const first = h.terminalSpawns[0]
	first.exit(0)
	const ended = (await h.state()).tabs.find((tab) => tab.id === 'terminal:dev-a')
	assert.equal(ended.state, 'ended')
	assert.equal(ended.exitCode, 0)

	// The tab stays, because its output is the only record of what happened; `⟲`
	// is how the operator gets a shell back without opening a second tab.
	const restarted = await h.call('tabs:restart', 'terminal:dev-a')
	const again = restarted.tabs.find((tab) => tab.id === 'terminal:dev-a')
	assert.equal(again.state, 'running')
	assert.equal(again.generation, 2, 'a reconnect reused the generation the renderer keys its screen on')
	assert.equal(h.terminalSpawns.length, 2)
})

await test('closing a terminal tab ends its session and returns to the device tab', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	await h.call('terminal:open', 'dev-a')
	const session = h.terminalSpawns[0]
	const state = await h.call('tabs:disconnect', 'terminal:dev-a')
	assert.deepEqual(state.tabs.map((tab) => tab.id), ['local', 'dev-a', 'dev-b'])
	assert.equal(state.activeId, 'dev-a')
	assert.equal(session.killed, 1, 'the ssh client was left running')
})

await test('removing a device closes the terminal that belonged to it', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	await h.call('terminal:open', 'dev-a')
	const session = h.terminalSpawns[0]
	await h.call('devices:remove', 'dev-a')
	const state = await h.state()
	assert.deepEqual(state.tabs.map((tab) => tab.id), ['local', 'dev-b'])
	assert.equal(session.killed, 1, 'a terminal outlived the device it named')
})

await test('a terminal whose shell family cannot be found fails with the reason', async () => {
	const h = harness({ devices: book, detectError: 'ssh: connect to host 10.0.0.2 port 22: Connection timed out' })
	await h.boot()
	await h.call('devices:list')
	const state = await h.call('terminal:open', 'dev-a')
	const tab = state.tabs.find((entry) => entry.id === 'terminal:dev-a')
	assert.equal(tab.state, 'failed')
	assert.match(tab.error ?? '', /Connection timed out/u)
	assert.equal(h.terminalSpawns.length, 0, 'a pty was started without a command to run')
})

console.log('local terminals')

await test('a shell on this machine opens in the home directory and starts one session', async () => {
	const h = harness({ devices: [] })
	await h.boot()
	const state = await h.call('terminal:openLocal', 'shell')
	const tab = state.tabs.find((entry) => entry.kind === 'terminal')
	assert.ok(tab !== undefined, `no local terminal tab: ${JSON.stringify(state.tabs)}`)
	assert.equal(tab.local, true)
	assert.equal(tab.preset, 'shell')
	assert.equal(tab.cwd, homedir())
	assert.match(tab.label, /^Shell — /u)
	assert.equal(tab.state, 'running')
	assert.equal(state.activeId, tab.id)
	// A local tab is not a Harness tab: the renderer must get no partition, or it
	// would build a guest for a tab that has no URL.
	assert.equal(tab.partition, undefined)
	assert.equal(h.terminalSpawns.length, 1)
	assert.equal(h.terminalSpawns[0].startOptions.preset, 'shell')
	assert.equal(h.terminalSpawns[0].startOptions.cwd, homedir())
	// A shell needs no folder chooser; one that appeared would be a click nobody
	// asked for.
	assert.equal(h.dialogCalls.length, 0)
})

await test('an agent asks for a project first, and the tab carries that directory', async () => {
	const project = join(HOME, 'project-a')
	mkdirSync(project, { recursive: true })
	const h = harness({ devices: [], dialog: { canceled: false, filePaths: [project] } })
	await h.boot()
	const state = await h.call('terminal:openLocal', 'pi')
	const tab = state.tabs.find((entry) => entry.kind === 'terminal')
	assert.ok(tab !== undefined)
	assert.equal(tab.preset, 'pi')
	assert.equal(tab.local, true)
	assert.equal(tab.cwd, project)
	assert.equal(tab.label, 'pi — project-a')
	assert.equal(h.terminalSpawns[0].startOptions.cwd, project)

	// The chooser's default is the last directory, not home: a second agent is one
	// click away from the first project, not back at the beginning.
	assert.equal(h.dialogCalls.length, 1)
	const options = h.dialogCalls[0].at(-1)
	assert.equal(options.defaultPath, homedir())
	assert.deepEqual(options.properties, ['openDirectory'])
	await h.call('terminal:openLocal', 'pi')
	assert.equal(h.dialogCalls[1].at(-1).defaultPath, project)
})

await test('cancelling the folder chooser opens no tab', async () => {
	const h = harness({ devices: [], dialog: { canceled: true, filePaths: [] } })
	await h.boot()
	const state = await h.call('terminal:openLocal', 'opencode')
	assert.equal(state.tabs.filter((entry) => entry.kind === 'terminal').length, 0)
	assert.equal(h.terminalSpawns.length, 0)
})

await test('a local tab reconnects in place, in the same directory', async () => {
	const project = join(HOME, 'project-b')
	mkdirSync(project, { recursive: true })
	const h = harness({ devices: [], dialog: { canceled: false, filePaths: [project] } })
	await h.boot()
	const opened = await h.call('terminal:openLocal', 'pi')
	const tab = opened.tabs.find((entry) => entry.kind === 'terminal')
	const first = h.terminalSpawns[0]
	first.exit(0)
	assert.equal((await h.state()).tabs.find((entry) => entry.id === tab.id).state, 'ended')

	const restarted = await h.call('tabs:restart', tab.id)
	const again = restarted.tabs.find((entry) => entry.id === tab.id)
	assert.equal(again.state, 'running')
	assert.equal(again.generation, 2, 'a reconnect reused the generation the renderer keys its screen on')
	assert.equal(h.terminalSpawns.length, 2)
	// The directory is part of the tab now; asking again would turn a reconnect into
	// a new conversation somewhere else.
	assert.equal(h.dialogCalls.length, 1)
	assert.equal(h.terminalSpawns[1].startOptions.cwd, project)
})

await test('a local tab closes like any other terminal', async () => {
	const h = harness({ devices: [] })
	await h.boot()
	const opened = await h.call('terminal:openLocal', 'shell')
	const tab = opened.tabs.find((entry) => entry.kind === 'terminal')
	const session = h.terminalSpawns[0]
	const state = await h.call('tabs:disconnect', tab.id)
	assert.equal(state.tabs.some((entry) => entry.id === tab.id), false)
	assert.equal(state.activeId, 'local')
	assert.equal(session.killed, 1, 'the shell was left running')
})

await test('a program that is not installed is reported on its tab', async () => {
	const h = harness({
		devices: [],
		dialog: { canceled: false, filePaths: [HOME] },
		localError: 'pi was not found on PATH; install it, or open a shell and start it there'
	})
	await h.boot()
	const state = await h.call('terminal:openLocal', 'pi')
	const tab = state.tabs.find((entry) => entry.kind === 'terminal')
	assert.ok(tab !== undefined, 'a failed start left no tab to explain itself on')
	assert.equal(tab.state, 'failed')
	assert.match(tab.error ?? '', /pi was not found on PATH/u)
	assert.equal(h.terminalSpawns.length, 0, 'a session was created for a program that was not resolved')
})

await test('the popover is told what this machine can open', async () => {
	const h = harness({ devices: [] })
	const answer = await h.call('terminal:presets')
	assert.deepEqual(
		answer.presets.map((entry) => entry.id),
		['shell', 'pi', 'opencode']
	)
})

rmSync(HOME, { recursive: true, force: true })

console.log(`\n${String(passes)} checks passed${failures.length === 0 ? '' : `, ${String(failures.length)} failed`}`)
if (failures.length > 0) process.exitCode = 1
