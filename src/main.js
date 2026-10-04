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

/** @type {BrowserWindow | undefined} */
let mainWindow

/** @type {Map<string, Tab>} */
const tabs = new Map()

/** The active tab id, as far as the renderer is concerned. */
let activeId = LOCAL_ID

/**
 * @typedef {object} Tab
 * @property {string} id
 * @property {'local'|'remote'} kind
 * @property {string} label
 * @property {'idle'|'starting'|'running'|'failed'} state
 * @property {string} [url]
 * @property {string} [error]
 * @property {ReturnType<typeof connect.connectLocal>} [connection]
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
 * Stop one tab, honouring the teardown contract.
 *
 * `connection.stop()` closes the server connection's stdin first, because that
 * EOF is what reaps the far side's server. Dropping the connection without it
 * leaves an orphan holding the remote port.
 *
 * @param tab - the tab to stop.
 */
function stopTab(tab) {
	const connection = tab.connection
	tab.connection = undefined
	tab.url = undefined
	tab.state = 'idle'
	if (connection !== undefined) connection.stop()
}

/**
 * Bring one tab up, starting whatever it needs.
 * @param id - the tab id.
 * @returns the tab's state after the attempt.
 */
async function activate(id) {
	const tab = tabs.get(id)
	if (tab === undefined) return
	activeId = id
	publish()
	if (tab.state === 'running' || tab.state === 'starting') return

	tab.state = 'starting'
	tab.error = undefined
	tab.lines = []
	publish()

	/** @type {{url?: string, error?: string} & Record<string, unknown>} */
	let result
	if (tab.kind === 'local') {
		result = await connect.connectLocal({ onLine: (line) => note(tab, line) })
	} else {
		const stored = await devices.load()
		const device = stored.find((entry) => entry.id === id)
		if (device === undefined) {
			tab.state = 'failed'
			tab.error = 'this device is no longer in the book'
			tab.lines.push('FAILED: this device is no longer in the book')
			publish()
			return
		}
		result = await connect.connectRemote(device, { onLine: (line) => note(tab, line) })
		if (result.platform !== undefined && device.platform !== result.platform) {
			device.platform = result.platform
			await persistPlatform(device)
		}
	}

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
	note(tab, `local URL: http://127.0.0.1:${String(new URL(result.url).port)}/`)

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
		return { devices: stored, tabs: snapshot() }
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
		const tab = tabs.get(key)
		if (tab !== undefined) {
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

void app.whenReady().then(async () => {
	installIpc()
	ensureLocal()
	createWindow()
	// The local Harness is what the operator opens the app for, so it comes up
	// without being asked. A remote device waits to be selected.
	await activate(LOCAL_ID)
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow()
	})
})

app.on('window-all-closed', () => {
	app.quit()
})

app.on('before-quit', () => {
	for (const tab of tabs.values()) stopTab(tab)
})
