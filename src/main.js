'use strict'

/**
 * dsh-tabs — a tabbed host for DSH web interfaces.
 *
 * The window is a tab bar and a content area, and every tab is one Harness web
 * UI: the local one, plus one per remote device reached over an ssh tunnel. All
 * tabs are peers and the bar is always visible, which is the whole reason this is
 * a separate application rather than a plugin in the Desktop shell — there, an
 * embedded surface has to live inside the surface it switches, so it can never
 * own the window chrome.
 *
 * Two decisions are worth naming up front:
 *
 * - **Shortcuts are handled here, in `before-input-event`, not in the page.** Key
 *   events do not cross into a `<webview>` guest, so a document listener in the
 *   renderer only works while focus is in the application's own chrome — which is
 *   almost never, because the operator is working inside a remote UI.
 *   `before-input-event` fires in the main process for every web contents, guest
 *   included, before the key reaches anyone.
 * - **The connect path lives in `connect.js`, not here.** It is the riskiest code
 *   in the app and it has no Electron dependency, so `tools/live-connect.mjs` can
 *   drive it against a real device with no window anywhere.
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron')
const { randomUUID } = require('node:crypto')
const { join } = require('node:path')

const devices = require('./devices.js')
const connect = require('./connect.js')
const remote = require('./remote.js')

/**
 * The message a Node-mode launch gets, or null when the Electron API is really
 * present.
 *
 * Kept as a pure function of `app` so the decision can be exercised without a
 * window, which is the whole problem this guard exists for: a launch that fails
 * this way fails *before* any window exists, and the environment that triggers it
 * — `ELECTRON_RUN_AS_NODE` set — is exactly the environment in which this
 * application cannot be launched to check. `tools/smoke.mjs` feeds both a real
 * API object and the string `require('electron')` actually returns in Node mode.
 *
 * @param electronApp - whatever `require('electron')` resolved to.
 * @returns the diagnosis, or null when it is usable.
 */
function nodeModeDiagnosis(electronApp) {
	if (typeof electronApp?.on === 'function') return null
	return [
		'dsh-tabs cannot start: this is running under Node, not Electron.',
		'Electron runs the entry point as a plain Node script when ELECTRON_RUN_AS_NODE is set,',
		'and in that mode `require(\'electron\')` returns the path to the binary instead of the API.',
		'',
		'Clear it and start again:',
		'',
		'    $env:ELECTRON_RUN_AS_NODE = $null    # PowerShell',
		'    unset ELECTRON_RUN_AS_NODE           # POSIX',
		''
	].join('\n')
}

// Refuse to run under Node, and say why.
//
// Without this, the first `app.on(...)` below throws
// `TypeError: Cannot read properties of undefined (reading 'on')` — a message
// naming a line of this file and not the variable that caused it, printed by a
// launch `npm start` reported as successful.
//
// `require('electron')` being a string is the check rather than the variable
// itself, because the string is the actual mechanism: clearing the variable is
// the fix, and anything else that produces the same state is worth catching too.
const diagnosis = nodeModeDiagnosis(app)
if (diagnosis !== null) {
	console.error(diagnosis)
	process.exit(1)
}

/** The tab id of the local Harness, which always exists and is always first. */
const LOCAL_ID = 'local'

/** The ids the chrome owns, from the one place that decides them. */
const { RESERVED_IDS } = devices

/** @type {BrowserWindow | undefined} */
let mainWindow

/** @type {Map<string, Tab>} */
const tabs = new Map()

/** The active tab id, as far as the renderer is concerned. */
let activeId = LOCAL_ID

/**
 * A connect that has been started and has not finished yet.
 *
 * One record, and everything about the attempt is on it. `activation` is the token
 * the tab hands out per attempt, `cancelled` is whether anybody has taken the
 * attempt away, `stopped` is whether its teardown has already run, and `stop` is
 * what that teardown is — filled in by the connect path the moment it has a process,
 * which is why `abort` exists beside it: for the stretches of a connect in which
 * nothing has been spawned yet, the caller's signal is the only channel.
 *
 * **Two records for one attempt is what made this hard.** The first version kept the
 * token on the tab and the pending state in a second object, so a cancellation that
 * landed between them — after the tab had handed out a token but before the connect
 * had registered anything to stop — was recorded in one and read from the other, and
 * the attempt carried on. Every window this code closes is a window between those
 * two, and there is now only one thing to keep in step.
 *
 * @typedef {object} Attempt
 * @property {string} activation
 * @property {boolean} cancelled
 * @property {boolean} stopped
 * @property {() => void} abort
 * @property {() => void} [stop]
 */

/**
 * @typedef {object} Tab
 * @property {string} id
 * @property {'local'|'remote'} kind
 * @property {string} label
 * @property {'idle'|'starting'|'running'|'failed'} state
 * @property {string} [url]
 * @property {string} [error]
 * @property {ReturnType<typeof connect.connectLocal>} [connection]
 * @property {Attempt} [attempt]
 * @property {string[]} lines
 */

/**
 * Append one timestamped step to a tab's transcript.
 * @param tab - the tab.
 * @param text - the line to record.
 */
function note(tab, text) {
	tab.lines.push(`[${new Date().toTimeString().slice(0, 8)}] ${text}`)
	if (tab.lines.length > 300) tab.lines.splice(0, tab.lines.length - 300)
}

/**
 * The tab list as the renderer sees it: serializable, with no child processes.
 * @returns the renderer-facing state.
 */
function snapshot() {
	return {
		activeId,
		tabs: [...tabs.values()].map((tab) => ({
			id: tab.id,
			kind: tab.kind,
			label: tab.label,
			state: tab.state,
			...(tab.url === undefined ? {} : { url: tab.url }),
			...(tab.error === undefined ? {} : { error: tab.error })
		}))
	}
}

/** Push the tab list to the renderer. */
function publish() {
	if (mainWindow === undefined || mainWindow.isDestroyed()) return
	mainWindow.webContents.send('tabs:state', snapshot())
}

/**
 * Cancel one tab's connect attempt, tearing down whatever it has started.
 *
 * **A connect in flight had no owner, and that leaked two ssh clients and a
 * far-side server.** `activate` attached its connection to the tab only after
 * every `await`, so for the whole of a connect — seconds, on a slow host — the
 * tab looked idle to everything that stops tabs: `×` did nothing, removing the
 * device deleted the tab and left the attempt running, and the quit path walked
 * `tabs` and found nothing to stop. The far side paid for it, with a `dsh web`
 * still holding a port on someone else's machine.
 *
 * What it calls is the attempt's own `stop`, which is the connect path's teardown
 * once there is a process to stop — `connectRemote` hands one over per spawn, and
 * `connectLocal` before it waits on the readiness line. Until then there is nothing
 * running and nothing to stop; the signal covers the waits that hold no process.
 *
 * @param tab - the tab whose attempt should be torn down.
 */
function cancelAttempt(tab) {
	const attempt = tab.attempt
	if (attempt === undefined) return
	// Cancelled first, and unconditionally: whatever else happens below, the attempt
	// must not be able to attach itself to the tab when it resolves.
	attempt.cancelled = true
	// The signal before the teardown: it is the only channel that reaches the connect
	// path while it waits on something that is not a process yet.
	attempt.abort()
	if (attempt.stop !== undefined && !attempt.stopped) {
		// Marked before the teardown runs, not after: a teardown that throws must
		// still leave the attempt marked, or `abandoned` would run it a second time.
		attempt.stopped = true
		attempt.stop()
	}
}

/**
 * Stop one tab, honouring the teardown contract.
 *
 * `connection.stop()` closes the server connection's stdin first, because that
 * EOF is what reaps the far side's server. Dropping the connection without it
 * leaves an orphan holding the remote port.
 *
 * A tab that has not finished connecting has no connection yet, so its attempt is
 * cancelled first — otherwise "stop" would mean "stop, unless it is still
 * starting", which is the leak this function used to have.
 *
 * @param tab - the tab to stop.
 */
function stopTab(tab) {
	cancelAttempt(tab)
	const connection = tab.connection
	tab.connection = undefined
	tab.url = undefined
	tab.state = 'idle'
	if (connection !== undefined) connection.stop()
}

/**
 * Whether a connect attempt no longer owns the tab it was started for.
 *
 * Called from `activate` immediately after every `await`, which is the only
 * reliable place to notice two things at once. The tab may be gone, the attempt may
 * have been cancelled by `cancelAttempt` — and a cancelled attempt still resolves,
 * because killing the child it was waiting on is what cancellation is.
 *
 * **The cancellation is a field on the attempt, not the absence of it.** An earlier
 * version compared the tab's token against the attempt's own and had `stopTab`
 * clear the token — which meant an attempt cancelled *before the token was set*
 * wrote the same value back and looked live again: `activate` hands the token out,
 * then reads the device book, and a test that fires the `×` inside that read caught
 * it. The tab's token says who the current attempt is; `cancelled` says whether
 * anybody has taken it away.
 *
 * An attempt whose teardown has already run is only *left alone* here; one that
 * lost the race for a tab that outlives it still owns what it built, and stops it
 * before the result goes out of scope.
 *
 * @param tab - the tab the attempt belongs to.
 * @param attempt - the attempt's own record.
 * @returns true when the attempt no longer owns the tab.
 */
function abandoned(tab, attempt) {
	if (tabs.get(tab.id) === tab && tab.activation === attempt.activation && !attempt.cancelled) return false
	if (attempt.stop !== undefined && !attempt.stopped) {
		attempt.stopped = true
		attempt.stop()
	}
	return true
}

/**
 * Bring one tab up, starting whatever it needs.
 *
 * **Every `await` in here is a window in which the operator can change their
 * mind, and the tab has to survive it.** The attempt carries a token, `stopTab`,
 * `devices:remove` and `before-quit` all invalidate it, and the check happens
 * after each suspension — see `abandoned`. `activate` is also the only entry
 * point for a connect, and a connect reads a file the operator can hand-edit, so
 * it is wrapped: a value the book can carry but a shell cannot (a NUL byte in
 * `host` makes `spawn` throw `ERR_INVALID_ARG_VALUE`) used to leave the tab
 * stuck at `starting` with an empty panel and no way back, because the rejection
 * went to whichever caller happened to be awaiting and nothing recorded it.
 *
 * @param id - the tab id.
 * @returns the tab's state after the attempt.
 */
async function activate(id) {
	const tab = tabs.get(id)
	if (tab === undefined) return
	activeId = id
	publish()
	if (tab.state === 'running' || tab.state === 'starting') return

	const activation = randomUUID()
	tab.activation = activation
	tab.state = 'starting'
	tab.error = undefined
	tab.lines = []
	// **The attempt's record is created here, before the first `await`, and lives
	// until this function is done with it.** A version of this that created it just
	// before the connect left the longest window of a remote connect uncovered:
	// `devices.load()` reads a file, and a `×` during it found no record to tear down,
	// so the connect started anyway and the tab came back up under a `×` the operator
	// had already pressed.
	//
	// Cancellation is synchronous — it closes a pipe and kills processes — so the
	// signal is a flag the connect path reads, never a promise anyone awaits. It is
	// what covers the waits that hold no process: the device-book read, the version
	// probe, the platform probe. `stop` covers everything after those, and the two
	// overlap on purpose, because a cancel has to work wherever the click lands.
	const controller = new AbortController()
	/** @type {Attempt} */
	const attempt = {
		activation,
		cancelled: false,
		stopped: false,
		abort: () => {
			controller.abort()
		}
	}
	tab.attempt = attempt
	publish()

	/**
	 * Collect one teardown from the connect path.
	 *
	 * `connectRemote` spawns twice — the server, then the tunnel — and a
	 * cancellation between them has to take *both* down, so the stops accumulate
	 * instead of replacing one another. The order is the teardown contract's: the
	 * server connection's stdin first, which is what reaps the far side.
	 *
	 * @param stop - what the connect path just handed over.
	 */
	const onChild = (stop) => {
		const already = attempt.stop
		attempt.stop = () => {
			for (const one of already === undefined ? [stop] : [already, stop]) one()
		}
	}

	/**
	 * Run one connect.
	 *
	 * Deliberately thin: it turns a throw into a result, and nothing else. Every
	 * question of ownership — has this been cancelled, has its teardown already run
	 * — is answered by `abandoned` at the call site, from the attempt record, so
	 * there is exactly one place that decides whether an attempt still owns the tab.
	 * An earlier version decided it here as well, and the two answers disagreed in a
	 * microtask-sized window: the connect's own bookkeeping ran a turn before the
	 * caller's, so a cancelled attempt was stopped twice.
	 *
	 * @param run - the connect to drive.
	 * @returns the connect result, or a synthetic failure when it threw.
	 */
	const runConnect = async (run) => {
		try {
			return await run(onChild)
		} catch (error) {
			// The operator sees this, so it is the thrown message rather than a
			// sentence of ours: the messages that reach here are the platform's own
			// (`spawn` refusing an argument, the OS refusing a port) and they name
			// the offending value.
			return { error: error instanceof Error ? error.message : String(error) }
		}
	}

	const signal = controller.signal

	try {
		/** @type {{url?: string, error?: string} & Record<string, unknown>} */
		let result
		if (tab.kind === 'local') {
			// No `await` before the connect here, so there is no window to check: the
			// local tab's own launch directory is not a device field, and the book is
			// not read for it at all.
			result = await runConnect((onChild) =>
				connect.connectLocal({
					signal,
					onLine: (line) => note(tab, line),
					onChild
				})
			)
		} else {
			const stored = await devices.load()
			if (abandoned(tab, attempt)) return
			const device = stored.find((entry) => entry.id === id)
			if (device === undefined) {
				tab.state = 'failed'
				tab.error = 'this device is no longer in the book'
				tab.lines.push('FAILED: this device is no longer in the book')
				publish()
				return
			}
			result = await runConnect((onChild) =>
				connect.connectRemote(device, {
					signal,
					onLine: (line) => note(tab, line),
					onChild
				})
			)
			if (result.platform !== undefined && device.platform !== result.platform) {
				device.platform = result.platform
				await persistPlatform(device)
			}
		}

		if (abandoned(tab, attempt)) return
		tab.activation = undefined

		if (result.error !== undefined) {
			tab.state = 'failed'
			tab.error = result.error
			note(tab, `FAILED: ${result.error}`)
			publish()
			return
		}

		tab.connection = /** @type {Tab['connection']} */ (result)
		tab.url = result.url
		tab.state = 'running'
		// What every tab's transcript says about its own URL. The wording used to be
		// "local URL", which was a lie on a remote tab and sent at least one reader
		// looking for a remote port that the tunnel does not use.
		note(tab, `URL: ${result.url}`)

		// A connection that dies later must not leave a `running` claim behind.
		result.onServerExit?.((code) => {
			if (tab.connection !== result || tab.state !== 'running') return
			tab.error = `the remote server connection ended (code ${String(code)})`
			note(tab, `FAILED: ${tab.error}`)
			stopTab(tab)
			tab.state = 'failed'
			publish()
		})
		result.onTunnelExit?.((code) => {
			if (tab.connection !== result || tab.state !== 'running') return
			tab.error = `the ssh tunnel ended (code ${String(code)})`
			note(tab, `FAILED: ${tab.error}`)
			stopTab(tab)
			tab.state = 'failed'
			publish()
		})
		publish()
	} catch (error) {
		// The belt to `runConnect`'s braces, and not redundant: `devices.load` reads
		// the operator's own file and `persistPlatform` writes it, and both sit
		// outside the connect. Anything thrown there used to end the process — this is
		// the same rejection the boot chain now catches, one layer in, where it can
		// name the tab it happened to.
		cancelAttempt(tab)
		if (abandoned(tab, attempt)) return
		tab.activation = undefined
		tab.state = 'failed'
		tab.error = error instanceof Error ? error.message : String(error)
		note(tab, `FAILED: ${tab.error}`)
		publish()
	} finally {
		// **The attempt stays reachable until this point, and that is the fix rather
		// than tidiness.** It used to be cleared the moment the connect returned,
		// which reopened the very window this change exists to close: between the
		// connect resolving and the tab owning the connection, `cancelAttempt` found no
		// record — and `abandoned` does not run until the caller is resumed, so for a
		// microtask there was nothing anywhere that could stop a connect which had
		// already spawned two ssh clients. Measured as a removed device that left its
		// connect running.
		if (tab.attempt === attempt) tab.attempt = undefined
	}
}

/**
 * Write a detected shell family back to the book, so the probe costs one round
 * trip per device rather than one per connect.
 *
 * Through `devices.mutate`, not `load` + `save`: this runs off the back of every
 * tab activation, so it is the write most likely to be in flight while the
 * popover is editing the same book, and a plain read-modify-write here could put
 * back a device the operator had just removed.
 *
 * @param device - the device that was classified.
 */
async function persistPlatform(device) {
	try {
		await devices.mutate((stored) =>
			stored.map((entry) => (entry.id === device.id ? { ...entry, platform: device.platform } : entry))
		)
	} catch {
		/* caching is an optimisation, not a requirement */
	}
}

/**
 * The tab for one device, created on first use.
 * @param device - the device record.
 * @returns the tab.
 */
function tabFor(device) {
	// A device whose id is one this application's own chrome uses must never become
	// a tab: `tabs` is keyed by id, so `local` would *be* the local tab, and the
	// label written here would replace its own. `devices.load` refuses to hand such
	// a record out — this is the assertion that it still does, at the one place
	// where the consequence would be silent.
	if (device.id === LOCAL_ID) return tabs.get(LOCAL_ID)
	const existing = tabs.get(device.id)
	if (existing !== undefined) {
		existing.label = device.label
		return existing
	}
	const created = {
		id: device.id,
		kind: /** @type {'remote'} */ ('remote'),
		label: device.label,
		state: /** @type {'idle'} */ ('idle'),
		lines: []
	}
	tabs.set(device.id, created)
	return created
}

/** Ensure the local tab exists and is first. */
function ensureLocal() {
	if (tabs.has(LOCAL_ID)) return
	tabs.set(LOCAL_ID, {
		id: LOCAL_ID,
		kind: /** @type {'local'} */ ('local'),
		label: 'Local',
		state: /** @type {'idle'} */ ('idle'),
		lines: []
	})
}

/** Build the window. */
function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1280,
		height: 820,
		minWidth: 720,
		minHeight: 480,
		backgroundColor: '#16161a',
		show: false,
		// The window's own icon, which is what the taskbar and Alt+Tab show while the
		// application is running. Without it they show the Electron binary's icon,
		// because that is the executable this runs as — `assets/icon.ico` is rendered
		// from `assets/icon.svg` by `tools/render-icon.cjs`. A missing file is not
		// fatal: Electron falls back to the executable's icon.
		icon: join(__dirname, '..', 'assets', 'icon.ico'),
		// The tab bar IS the window chrome, the way a terminal emulator does it:
		// the OS draws its controls over the same band the tabs live in.
		titleBarStyle: 'hidden',
		...(process.platform === 'darwin'
			? { trafficLightPosition: { x: 12, y: 12 } }
			: { titleBarOverlay: { height: 40, color: '#16161a', symbolColor: '#c9c9cf' } }),
		webPreferences: {
			preload: join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			// `sandbox: false` is deliberate: this is the one window that needs
			// `webviewTag`, and the isolated-preload path is the well-trodden one
			// for it. The guests are what need locking down, and they are.
			sandbox: false,
			webviewTag: true
		}
	})
	mainWindow.once('ready-to-show', () => {
		mainWindow?.show()
	})
	mainWindow.on('closed', () => {
		mainWindow = undefined
	})
	// The window-open rule is not set here: `installShortcuts` installs one for
	// every web contents, the main window's included, so there is exactly one
	// place that decides where a link goes.
	// Surface renderer errors on the terminal. Without this a policy violation or
	// a thrown script is a blank window with no explanation anywhere, which is the
	// least debuggable failure a GUI can have.
	mainWindow.webContents.on('console-message', (details) => {
		if (details.level !== 'error' && details.level !== 'warning') return
		console.error(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${String(details.lineNumber)})`)
	})
	mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
		console.error(`[renderer] failed to load ${url}: ${description} (${String(code)})`)
	})
	void mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'))
}

/** Contents already wired, so the two registration paths cannot double up. */
const wired = new WeakSet()

/**
 * Give one web contents the window-open rule and the shortcut routing.
 * @param contents - the contents to wire.
 */
function wireContents(contents) {
	if (wired.has(contents)) return
	wired.add(contents)
	// Every contents, guests included, gets the same window-open rule. Setting it
	// only on the main window would leave a link clicked inside a remote interface
	// opening an unmanaged Electron window with no tab bar and no way back.
	contents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/u.test(url)) void shell.openExternal(url)
		return { action: 'deny' }
	})
	contents.on('before-input-event', (event, input) => {
		if (!input.alt || input.control || input.meta || input.shift) return
		if (input.type !== 'keyDown' || input.isAutoRepeat) return
		const match = /^(?:Digit|Numpad)([1-9])$/u.exec(input.code)
		if (match === null) return
		const target = [...tabs.keys()][Number(match[1]) - 1]
		if (target === undefined) return
		event.preventDefault()
		activeId = target
		publish()
		if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send('tabs:shortcut', target)
		}
		// A tab that has never been up still needs starting; `activate` is
		// idempotent for one that is already running.
		void activate(target)
	})
}

/**
 * Route Alt+1…9 to the active window, wherever the focus happens to be.
 *
 * This is the reason the shortcut lives in the main process. `before-input-event`
 * fires for every web contents — the window's own and every `<webview>` guest —
 * before the key is delivered anywhere, so the same handler covers focus in the
 * app's chrome and focus deep inside a remote interface. A renderer-side
 * `keydown` listener would only ever see the first case.
 *
 * The guest is reached through **both** hooks on purpose. `web-contents-created`
 * is documented only as "emitted when a new webContents is created", and a guest
 * is one, so it should cover them — but that is an inference, this application's
 * headline feature rests on it, and the Desktop shell reaches its own guests
 * through `did-attach-webview` instead. Covering both costs one set lookup and
 * removes the bet.
 */
function installShortcuts() {
	app.on('web-contents-created', (_event, contents) => {
		wireContents(contents)
		contents.on('did-attach-webview', (_attachEvent, guest) => {
			wireContents(guest)
		})
	})
}

/** Wire the renderer's requests. */
function installIpc() {
	ipcMain.handle('tabs:get', () => snapshot())
	ipcMain.handle('tabs:activate', async (_event, id) => {
		await activate(String(id))
		return snapshot()
	})
	ipcMain.handle('tabs:disconnect', async (_event, id) => {
		// A device tab is not "closed": it is one of the configured things and stays
		// in the bar so the next click or Alt+digit brings it back. What this does is
		// stop it — tearing down the tunnel and the remote server — which is the
		// honest opposite of opening it. Removing a device is the popover's job.
		//
		// `stopTab` covers a connect in flight as well as a settled one. It did not,
		// and the `×` drawn beside a tab that says "starting" was therefore a control
		// that did nothing at all — the exact moment an operator reaches for it.
		const key = String(id)
		if (key === LOCAL_ID) return snapshot()
		const tab = tabs.get(key)
		if (tab !== undefined) {
			stopTab(tab)
			publish()
		}
		return snapshot()
	})
	ipcMain.handle('devices:list', async () => {
		const stored = await devices.load()
		for (const device of stored) tabFor(device)
		publish()
		// The reasons a hand-edited book lost a record, carried with the list so the
		// popover can show them. Without this the device is simply absent — the one
		// failure mode a hand-editable file must not have.
		return { devices: stored, tabs: snapshot(), problems: devices.problems() }
	})
	ipcMain.handle('devices:open', async (_event, id) => {
		await activate(String(id))
		return snapshot()
	})
	ipcMain.handle('devices:save', async (_event, incoming) => {
		/** @type {import('./devices.js').Device | undefined} */
		let saved
		const stored = await devices.mutate((current) => {
			const at = current.findIndex((entry) => entry.id === incoming?.id)
			const device = devices.normalize(incoming, at === -1 ? undefined : current[at])
			if (device.host === '' || device.user === '') throw new Error('host and user are required')
			// The id rules — not one of the ids this application's own chrome uses, and
			// not one already in the book — are checked here as well as in `devices.js`,
			// because this is the door an operator reaches through the UI and the
			// message has to arrive while they are looking at the field. `normalize`
			// itself cannot check them: it sees one record, not the book.
			const idProblem = devices.validateId(device.id, current, at === -1 ? undefined : current[at])
			if (idProblem !== null) throw new Error(idProblem)
			// Refused here rather than at launch: a directory that no shell in this
			// application can be given is a typo or an attack, and either way the
			// operator should learn it while looking at the field they typed it into.
			// `connect.js` checks the same thing again, because the book can also be
			// written by hand.
			const problem = remote.directoryProblem(device.directory)
			if (problem !== null) throw new Error(problem)
			if (at === -1) current.push(device)
			else current[at] = device
			saved = device
			return current
		})
		// A tab exists per device, so the one just saved needs one too — including
		// when it is a new device, which has never appeared in the bar before.
		if (saved !== undefined) tabFor(saved)
		publish()
		return { devices: stored }
	})
	ipcMain.handle('devices:remove', async (_event, id) => {
		const key = String(id)
		// The book cannot contain a device with this id — `devices.load` leaves such a
		// record out — so nothing is being protected from the operator here. What this
		// stops is a hand-edited book, an old tab or a future IPC caller from deleting
		// the local tab and tearing the local Harness down with it, which is a state
		// nothing recreates: `ensureLocal` runs once, at boot.
		if (RESERVED_IDS.includes(key)) return { devices: await devices.load() }
		const tab = tabs.get(key)
		if (tab !== undefined) {
			// Before the tab leaves the map, which is what makes the connect in flight
			// findable: `stopTab` tears the attempt down *and* the settled connection,
			// and `tabs.delete` afterwards leaves the attempt nothing to come back to.
			stopTab(tab)
			tabs.delete(key)
		}
		const stored = await devices.mutate((current) => current.filter((entry) => entry.id !== key))
		if (activeId === key) activeId = LOCAL_ID
		publish()
		return { devices: stored }
	})
	ipcMain.handle('devices:transcript', (_event, id) => {
		const tab = tabs.get(String(id))
		return { lines: tab === undefined ? [] : tab.lines }
	})
}

installShortcuts()
// **The two that do not need a ready application happen here, not inside the chain,
// because the chain's own failure has to be reportable.** `installIpc` and
// `ensureLocal` used to be the first two calls inside `.then(...)`, which made the
// `.catch` below unable to say anything at all: with no renderer channel there is no
// way to draw the local tab's failure, and with no local tab there is nothing to
// record it on — so a boot failure was one line on a terminal nobody was reading, in
// front of an empty screen. Neither call needs Electron to be ready (a handler is
// inert until a window asks, and the tab is a plain object), so both move out and the
// `.catch` gets something to write to.
installIpc()
ensureLocal()

void app
	.whenReady()
	.then(async () => {
		createWindow()
		// The local Harness is what the operator opens the app for, so it comes up
		// without being asked. A remote device waits to be selected.
		await activate(LOCAL_ID)
		app.on('activate', () => {
			if (BrowserWindow.getAllWindows().length === 0) createWindow()
		})
	})
	.catch((error) => {
		// **A throw anywhere above used to end the process with no window and no
		// message.** Node's default for a rejection nobody handles is to terminate, and
		// this chain is the one that has to survive: measured by making the port
		// allocator throw, the whole application exited `1` before it had drawn
		// anything.
		const reason = error instanceof Error ? error.message : String(error)
		console.error(`dsh-tabs could not finish starting: ${reason}`)
		const local = tabs.get(LOCAL_ID)
		if (local !== undefined) {
			local.state = 'failed'
			local.error = `the application could not finish starting: ${reason}`
			local.lines.push(`FAILED: ${local.error}`)
		}
		// Attempted, so the failure has somewhere to be read rather than only printed:
		// a window whose whole content is the reason the application could not start.
		// Guarded because the reason this handler is running is that something above it
		// failed, and a `createWindow` that throws here would reject the handler and put
		// the process back where it was — exiting with nothing at all.
		try {
			if (mainWindow === undefined || mainWindow.isDestroyed()) createWindow()
			publish()
		} catch {
			/* no window is possible; the terminal line above is what is left */
		}
	})

app.on('window-all-closed', () => {
	app.quit()
})

app.on('before-quit', () => {
	// Every tab, including the ones whose connect has not finished: `stopTab` tears
	// down an attempt in flight, which is what used to be left running here while
	// the application exited and the far side kept a server holding its port.
	for (const tab of tabs.values()) stopTab(tab)
})
