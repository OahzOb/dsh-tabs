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
	const exits = { server: [], tunnel: [] }
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
		return {
			url: 'http://127.0.0.1:19999/?token=fake',
			platform: 'posix',
			stop() {
				stopped += 1
				stops.push(overrides.url ?? 'http://127.0.0.1:19999/?token=fake')
			},
			/** Test-only: how many times this connection was torn down. A count, not a
			 * flag, because the defect this suite is watching for is a *second*
			 * teardown — of a pipe that is already closed, or of a pid that has been
			 * reused — and a boolean cannot see it. */
			stopCount: () => stopped,
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

	const connectStub = {
		sshExecutable: () => 'ssh',
		async connectLocal(callOptions = {}) {
			return pending(callOptions)
		},
		async connectRemote(_device, callOptions = {}) {
			return pending(callOptions)
		}
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
			exit: () => {}
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
			}
		},
		shell: { openExternal: () => {} }
	}

	// Intercept the two modules the main process reaches for. Everything else —
	// including the real device book and the real normalization — stays real.
	const Module = require('node:module')
	const original = Module._load
	Module._load = function load(request, parent, isMain) {
		if (request === 'electron') return electronStub
		if (request === './connect.js') return connectStub
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
		queue,
		ok,
		pending,
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
		call: (channel, ...args) => ipc.get(channel)({}, ...args)
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

console.log('alt+digit')

await test('alt+digit selects a tab and tells the renderer', async () => {
	const h = harness({ devices: book })
	await h.boot()
	await h.call('devices:list')
	const result = h.press({ code: 'Digit2' })
	assert.equal(result.prevented, true, 'the key was not consumed')
	await waitFor(async () => (await h.state()).tabs[1]?.state === 'running', 'the shortcut to start its tab')
	const state = await h.state()
	assert.equal(state.activeId, 'dev-a')
	assert.equal(state.tabs[1].state, 'running', 'the shortcut did not start the tab it selected')
	assert.ok(h.sent.some(([channel, payload]) => channel === 'tabs:shortcut' && payload === 'dev-a'))
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
	await waitFor(async () => (await h.state()).tabs[1]?.state === 'running', 'the guest shortcut to start its tab')
	const state = await h.state()
	assert.equal(state.activeId, 'dev-a')
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

rmSync(HOME, { recursive: true, force: true })

console.log(`\n${String(passes)} checks passed${failures.length === 0 ? '' : `, ${String(failures.length)} failed`}`)
if (failures.length > 0) process.exitCode = 1
