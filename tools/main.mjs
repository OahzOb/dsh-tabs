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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
 * @param options - the device book and the connect results to hand out.
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
	const line = (text) => text

	/**
	 * Build one connection result.
	 * @param overrides - fields to override.
	 * @returns the result the real `activate` will consume.
	 */
	function ok(overrides = {}) {
		let serverExit
		let tunnelExit
		return {
			url: 'http://127.0.0.1:19999/?token=fake',
			platform: 'posix',
			stop() {
				stops.push(overrides.url ?? 'http://127.0.0.1:19999/?token=fake')
			},
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

	const connectStub = {
		sshExecutable: () => 'ssh',
		async connectLocal(callOptions = {}) {
			callOptions.onLine?.(line('local program: fake'))
			const next = queue.shift()
			return next === undefined ? ok() : next
		},
		async connectRemote(_device, callOptions = {}) {
			callOptions.onLine?.(line('connect fake'))
			const next = queue.shift()
			return next === undefined ? ok() : next
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
			whenReady: () => ready,
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

	const contentsListeners = new Map()
	const contents = {
		on(event, listener) {
			contentsListeners.set(event, listener)
		},
		setWindowOpenHandler: () => {}
	}

	return {
		ipc,
		sent,
		stops,
		queue,
		ok,
		/**
		 * Press a key, the way Electron reports it.
		 * @param overrides - fields of the Input object.
		 */
		press(overrides = {}) {
			const input = { type: 'keyDown', key: '1', code: 'Digit1', alt: true, control: false, meta: false, shift: false, isAutoRepeat: false, ...overrides }
			let prevented = false
			contentsListeners.get('before-input-event')?.({ preventDefault: () => { prevented = true } }, input)
			return { prevented }
		},
		/**
		 * Let the main process finish its asynchronous boot.
		 *
		 * Two waits, because there are two preconditions and neither of them is a
		 * duration: the `whenReady` continuation has to install the IPC handlers
		 * before anything can be asked of it, and only then can the local tab be
		 * watched until it is genuinely `running`.
		 */
		async boot() {
			for (const listener of appListeners.get('web-contents-created') ?? []) listener({}, contents)
			readyResolve()
			await waitFor(() => ipc.has('tabs:get'), 'the window to install its IPC handlers')
			await waitFor(async () => {
				const state = await ipc.get('tabs:get')()
				return state.tabs[0]?.state === 'running'
			}, 'the local tab to come up')
		},
		/** Emit an app-level event such as `before-quit`. */
		emitApp(event) {
			for (const listener of appListeners.get(event) ?? []) listener()
		},
		state: () => ipc.get('tabs:get')(),
		call: (channel, ...args) => ipc.get(channel)({}, ...args)
	}
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
