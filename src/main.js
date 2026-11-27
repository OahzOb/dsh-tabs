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

const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, session } = require('electron')
const { randomUUID } = require('node:crypto')
const { existsSync } = require('node:fs')
const { homedir } = require('node:os')
const { basename, join } = require('node:path')

const devices = require('./devices.js')
const connect = require('./connect.js')
const remote = require('./remote.js')
const localdsh = require('./localdsh.js')
const terminal = require('./terminal.js')
const askpass = require('./askpass.js')

/** This application's own version, read from the manifest beside the source. */
const PACKAGE = require('../package.json')

/**
 * What to print and exit with for one launch, or null to start the application.
 *
 * **Answering `--version` is not a nicety here; not answering it starts a whole
 * Harness nobody asked for.** A packaged Electron application has no version flag of
 * its own: `dsh-tabs.exe --version` reaches this file like any other launch, comes up
 * as a normal window, starts the local `dsh web`, and returns nothing to the shell
 * that asked — so the command that looks like it *reads* something instead spawns a
 * second copy of the application, and the local Harness under it holds a port and a
 * session store until somebody notices the window. Measured on this machine: a
 * probe of the installed binary's version left a second `dsh-tabs.exe` with its own
 * `cmd.exe → node` tree alive, which is one half of "closing the desktop does not
 * close the web process" — the other half being a copy that was never closed at all.
 *
 * The whole argv is checked rather than the first element, because the flag can
 * arrive behind Electron's own switches (`dsh-tabs.exe --enable-logging --version`),
 * and Electron strips its own before this file runs.
 *
 * Kept as a pure function of the arguments and the version so `tools/main.mjs` can
 * exercise both answers — including the one that must **not** fire, which is an
 * argument that merely looks like a flag.
 *
 * @param argv - the process arguments, as `electron .` or a packaged binary sees them.
 * @param version - the version to report.
 * @returns the text to print, or null to start the application.
 */
function launchAnswer(argv, version) {
	const args = Array.isArray(argv) ? argv.map((value) => String(value)) : []
	if (args.includes('--version') || args.includes('-v')) return `${String(version)}\n`
	if (args.includes('--help') || args.includes('-h')) {
		return [
			`dsh-tabs ${String(version)} — a tabbed host for DSH web interfaces.`,
			'',
			'Launching the binary is the only command; it opens a window whose tabs are the',
			'local Harness and one per device in ~/.dsh/dsh-tabs.json.',
			'',
			'  --version, -v   print the version and exit',
			'  --help, -h      print this and exit'
		].join('\n') + '\n'
	}
	return null
}

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
const nodeMode = nodeModeDiagnosis(app)
if (nodeMode !== null) {
	console.error(nodeMode)
	process.exit(1)
}

// Answer `--version` and `--help` before anything is created, so the answer costs
// no window and no Harness. See `launchAnswer` for why this is load-bearing rather
// than polite.
const answer = launchAnswer(process.argv.slice(1), PACKAGE.version)
if (answer !== null) {
	process.stdout.write(answer)
	process.exit(0)
}

/** The tab id of the local Harness, which always exists and is always first. */
const LOCAL_ID = 'local'

/**
 * The prefix that keeps a terminal tab's id out of the device book's namespace.
 *
 * `tabs` is keyed by id and a device tab's id is the device's own, so a terminal
 * for `dev-a` needs an id no device can hold by accident. The prefix is not a
 * guarantee — the book is hand-editable and an operator can call a device
 * `terminal:dev-a` — so `terminalTabFor` checks the other tab's kind before it
 * writes anything, and refuses rather than overwriting a Harness tab.
 */
const TERMINAL_PREFIX = 'terminal:'

/** The ids the chrome owns, from the one place that decides them. */
const { RESERVED_IDS } = devices

/**
 * The session partition one Harness tab's guest runs in.
 *
 * **A guest's session must not be shared with any other guest, and it must not be
 * the window's.** `dsh web` authenticates a browser with a cookie named after the
 * request's authority — `dsh-auth-` plus a digest of `host:port` — so every Harness
 * process a guest is pointed at contributes one more cookie for `127.0.0.1`, and a
 * browser sends **every** cookie for a host regardless of the port it was minted
 * for. In the default, persistent session those cookies accumulated across launches
 * and restarts until the Cookie request header crossed Node's 16 KiB
 * `maxHeaderSize`: the Harness then answered every request, the readiness URL
 * included, with `431` and an empty body, every tab said `running`, and every guest
 * was a blank rectangle with nothing logged on either side. Measured 2026-11-21:
 * 70 cookies, 15,750 bytes of name+value, after about a month of ordinary use.
 *
 * The partition is **in memory** (no `persist:` prefix) on purpose. The cookie it
 * holds dies with the Harness process that minted it, so there is nothing worth
 * carrying across a launch, and a persistent partition would only become a slow
 * version of the same leak — one cookie per restart. It is also per tab, because
 * the tab is what a session belongs to: `clearGuestSession` can empty one tab's
 * session without signing any other tab out.
 */
const GUEST_PARTITION_PREFIX = 'dsh-tabs-guest-'

/**
 * The session partition name for one tab.
 * @param id - the tab id.
 * @returns the partition name.
 */
function guestPartition(id) {
	return `${GUEST_PARTITION_PREFIX}${id}`
}

/** The prefix `dsh web` gives its browser-session cookie. */
const AUTH_COOKIE_PREFIX = 'dsh-auth-'

/** @type {BrowserWindow | undefined} */
let mainWindow

/** @type {Map<string, Tab>} */
const tabs = new Map()

/**
 * Passwords typed this run, by device id.
 *
 * **This map is the whole store.** A password is written here when the operator
 * types it, read back for a reconnect or a terminal within the same run, and
 * deleted when the far side refuses it — never written to the device book, never
 * handed to the renderer a second time, never present in a transcript. A new
 * launch starts empty and asks again, which is the behaviour the Android client
 * chose for the same reason: a password on disk is a password a backup, a
 * screenshot or a shared profile can carry off the machine, and the cost of not
 * having one is typing it once per run.
 *
 * @type {Map<string, string>}
 */
const passwords = new Map()

/**
 * Where the askpass helper lives.
 *
 * The application's own user-data directory, because it is per-user, already
 * private to the account, and removed with the profile. `DSH_TABS_ASKPASS_DIR`
 * exists for the suites: they must not leave a helper in the operator's profile,
 * and a test that writes to a real `%APPDATA%` is a test that eventually deletes
 * something it did not create.
 *
 * @returns a directory path.
 */
function askpassDirectory() {
	const override = process.env.DSH_TABS_ASKPASS_DIR
	if (typeof override === 'string' && override !== '') return override
	try {
		return join(app.getPath('userData'), 'askpass')
	} catch {
		// A stubbed Electron in the suites has no `getPath`, and a launch that
		// somehow reaches this before `app` is ready still has a private-enough
		// place to put one file.
		return join(homedir(), '.dsh', 'dsh-tabs', 'askpass')
	}
}

/**
 * The password one device should use for this attempt, remembered if it was given.
 *
 * Exactly one rule: a supplied password wins over the remembered one, and a device
 * that is not configured for password auth has none at all. The distinction
 * between "not supplied" and "not configured" is what lets the caller decide
 * whether to prompt or to proceed.
 *
 * @param device - the device record.
 * @param supplied - the password the operator just typed, if any.
 * @returns the password, or undefined when there is none to use.
 */
function passwordFor(device, supplied) {
	if (device === undefined || device.auth !== 'password') return undefined
	const secret = typeof supplied === 'string' && supplied !== '' ? supplied : passwords.get(device.id)
	if (secret === undefined || secret === '') return undefined
	passwords.set(device.id, secret)
	return secret
}

/**
 * The renderer's request for a password, and why it is being asked again.
 *
 * `label`, `user` and `host` are there so the dialog can name the machine without
 * the renderer looking it up in a book it does not otherwise read; `error` is the
 * far side's refusal, present only when a password was already tried.
 *
 * @param device - the device the password is for.
 * @param error - what the previous attempt said, if it said anything.
 * @returns the payload the renderer's dialog needs.
 */
function passwordPrompt(device, error) {
	return {
		id: device.id,
		label: device.label,
		user: device.user,
		host: device.host,
		...(error === undefined ? {} : { error })
	}
}

/** The active tab id, as far as the renderer is concerned. */
let activeId = LOCAL_ID

/**
 * Where the folder chooser starts the next time one is opened.
 *
 * A preset that runs in a project (`pi`, `opencode`) asks for a directory every time
 * it is opened, and the first folder an operator picks is almost always the
 * neighbourhood of the next one. The value is **not persisted**: it is a convenience
 * for this run, not a setting, and a stale project path from last month is a worse
 * default than the home directory.
 */
let lastDirectory = homedir()

// **One instance, because the local Harness is a per-machine resource and the
// operator cannot see the second copy.** Without this, every launch — a shortcut
// pressed twice, a `--version` probe by an older build, a shell that re-runs the
// binary — becomes another window *and another `dsh web`*, and closing the window
// the operator was looking at leaves the other copy's web process running with
// nothing on screen that owns it. That is the observable half of "closing the
// desktop does not close the web process": the process is real and reachable, and
// the window that would have reaped it was never the one closed.
//
// The second launch does not fail silently or open a duplicate: it says what
// happened and brings the existing window forward, which is what the operator
// meant by launching again.
//
// Nothing is set up when the lock is refused, rather than being set up and then
// abandoned: a second instance that registered the boot chain, the IPC handlers and
// the local tab would start a Harness of its own on the way out, which is the exact
// duplicate this exists to prevent.
//
// **This sits below the declarations, and that is the fix for a real crash rather
// than tidiness.** The handler registered here reads `mainWindow`, and a `let` cannot
// be read until its declaration has been evaluated: with the declarations further
// down the file, a second launch that landed while this module was still being
// evaluated threw `ReferenceError: Cannot access 'mainWindow' before initialization`
// from inside the handler, and Electron answered that with a main-process error
// dialog **over the running application** — measured on the installed build, whose
// window title became `Error` and whose dialog named `main.js:164:3`. The window for
// it is the whole of `startApplication()`'s evaluation, which is long enough to hit
// (a first launch puts the app together for tens of milliseconds before the handler
// exists). Everything a registered handler can reach has to exist before the handler
// is registered.
// TEMPORARY-REPRO: declarations moved back below the handler to prove the check bites.
const owned = app.requestSingleInstanceLock()
if (!owned) {
	console.error('dsh-tabs is already running; bringing its window forward instead of starting a second local Harness.')
	// **`exit`, not `quit`, and it is load-bearing.** With nothing registered above —
	// no window, no boot chain, no `window-all-closed` handler — a `quit()` has no
	// window to close and emits `before-quit` on the way to nothing, which is a
	// process that sits there holding a devtools port and looking alive. Measured in a
	// real window: the refused second launch printed this line and then stayed
	// running. `exit` is unconditional and, unlike `quit`, cannot reach an event a
	// losing instance has no business handling.
	app.exit(0)
} else {
	app.on('second-instance', () => {
		if (mainWindow === undefined || mainWindow.isDestroyed()) return
		if (mainWindow.isMinimized()) mainWindow.restore()
		mainWindow.show()
		mainWindow.focus()
	})
	startApplication()
}

/**
 * Everything one instance of this application does.
 *
 * A function, and called from exactly one place — the branch above that holds the
 * single-instance lock — for one reason: this body registers process-wide things, and
 * the losing instance has to leave all of them unregistered. The declarations it uses
 * sit **above** the lock, not in here, because the handler registered there reads
 * `mainWindow` and a `let` cannot be read before its declaration has been evaluated.
 */
function startApplication() {

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
 * @property {'local'|'remote'|'terminal'} kind
 * @property {string} [deviceId] - the device a terminal tab belongs to.
 * @property {'shell'|'pi'|'opencode'} [preset] - the program a local terminal runs.
 * @property {string} [cwd] - the directory a local terminal starts in.
 * @property {string} label
 * @property {'idle'|'starting'|'running'|'failed'|'ended'} state
 * @property {string} [url]
 * @property {string} [error]
 * @property {number} [exitCode] - how a terminal's ssh client ended.
 * @property {number} [generation] - which session a terminal tab is showing.
 * @property {boolean} [attachRequested] - whether the renderer is waiting for the pty.
 * @property {boolean} [persistent] - whether this tab's host outlives its connection.
 * @property {boolean} [adopted] - whether the host was already running when this tab connected.
 * @property {number} [localPort] - the stable forward port a persistent tab holds.
 * @property {'posix'|'windows'} [platform] - the shell family the far side answered with.
 * @property {ReturnType<typeof setTimeout>} [reconnectTimer] - a scheduled tunnel retry.
 * @property {number} [reconnectAttempt] - how many retries this outage has cost.
 * @property {ReturnType<typeof connect.connectLocal>} [connection]
 * @property {ReturnType<typeof terminal.start>} [terminal]
 * @property {Attempt} [attempt]
 * @property {{cancelled: boolean, stop: () => void}} [terminalAttempt]
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
			...(tab.error === undefined ? {} : { error: tab.error }),
			// A terminal's renderer needs to know whether the session it is looking at
			// is still the one the main process owns — that is what a reconnect of the
			// same tab changes — and how a finished one ended. Both are ordinary fields
			// of a serializable state push, not a second IPC channel.
			//
			// A Harness tab's renderer needs the session partition its guest must be
			// created in, for the reason `GUEST_PARTITION_PREFIX` records. The renderer
			// does not derive the name, so the one place that decides what a partition
			// means stays in this file.
			...(tab.kind === 'terminal'
				? {
						generation: tab.generation ?? 0,
						// A terminal is either bound to a device or opened on this
						// machine, and the renderer does not need to know which of the
						// two it is looking at to draw it — but its tooltip shows the
						// whole path, and a label alone cannot carry that back.
						...(tab.deviceId === undefined
							? { local: true, preset: tab.preset, cwd: tab.cwd }
							: { deviceId: tab.deviceId }),
						...(tab.exitCode === undefined ? {} : { exitCode: tab.exitCode })
					}
				: {
						partition: guestPartition(tab.id),
						// A persistent tab's renderer is told what the tab is, not asked to
						// infer it from a state name: it decides whether the guest may be
						// destroyed (it may not, while the host is still there) and what the
						// banner says.
						...(tab.persistent === true ? { persistent: true, adopted: tab.adopted === true } : {})
					})
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
	// path while it waits on something that is not a process yet. A listener that
	// throws is not allowed to stop the cancellation — the tab still has to reach a
	// state the operator can act on.
	try {
		attempt.abort()
	} catch {
		/* the attempt is marked cancelled above either way */
	}
	if (attempt.stop !== undefined && !attempt.stopped) {
		// Marked before the teardown runs, not after: a teardown that throws must
		// still leave the attempt marked, or `abandoned` would run it a second time.
		attempt.stopped = true
		try {
			attempt.stop()
		} catch {
			// **A teardown that throws must not hide the outcome.** A failed connect
			// still has to become a `failed` tab with its reason, and this is called on
			// that path now; a stop that cannot run is reported by the process it could
			// not stop, not by a tab stuck at `starting`.
		}
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
 * @param {object} [options] - how far to go.
 * @param {boolean} [options.keepPage] - keep the guest and the URL for a persistent tab.
 * @param {boolean} [options.terminate] - end the far-side host as well (a restart).
 */
function stopTab(tab, options = {}) {
	if (tab.kind === 'terminal') {
		// A terminal is not a Harness: there is no far-side process to reap with an
		// EOF, so stopping it is the local ssh client's kill and nothing else. The
		// tab is left in place for the quit path, which is the only caller that
		// stops tabs without deciding what should be shown afterwards.
		cancelTerminal(tab)
		const session = tab.terminal
		tab.terminal = undefined
		tab.state = 'idle'
		if (session !== undefined) session.kill()
		return
	}
	cancelReconnect(tab)
	cancelAttempt(tab)
	const connection = tab.connection
	tab.connection = undefined
	// **Closing the tab of a persistent host means "let go", not "kill it".** The
	// page and its URL stay, because the host behind them is still the same process
	// on the same port — and `connect.stop()` only drops the tunnel. This is what a
	// disconnect, a quit and a lost connection all look like; `terminate` is the one
	// that ends the host, and only a restart or an explicit "Stop host" asks for it.
	if (connection?.persistent === true && options.keepPage === true) {
		tab.state = 'detached'
		connection.detach?.()
		return
	}
	tab.url = undefined
	tab.state = 'idle'
	if (connection !== undefined) {
		if (options.terminate === true && typeof connection.terminate === 'function') void connection.terminate()
		else connection.stop()
	}
}

/**
 * Drop a pending tunnel retry, if there is one.
 * @param tab - the tab.
 */
function cancelReconnect(tab) {
	if (tab.reconnectTimer !== undefined) {
		clearTimeout(tab.reconnectTimer)
		tab.reconnectTimer = undefined
	}
}

/**
 * Come back to a host whose tunnel went away.
 *
 * The page is not touched and the URL is not cleared: this is only about
 * re-opening the forward. `activate` re-runs the whole connect, which is
 * deliberate — the ensure program adopts the same host, so the re-run costs one
 * ssh round trip and no new process, and a host that really did die is restarted
 * by the same command.
 * @param tab - the tab whose tunnel ended.
 */
function scheduleReconnect(tab) {
	cancelReconnect(tab)
	const attempt = (tab.reconnectAttempt ?? 0) + 1
	tab.reconnectAttempt = attempt
	const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt - 1, 5))
	note(tab, `reconnect in ${String(Math.round(delay / 1000))}s (attempt ${String(attempt)})`)
	tab.reconnectTimer = setTimeout(() => {
		tab.reconnectTimer = undefined
		void activate(tab.id)
	}, delay)
	// Electron would keep the process alive for a timer nobody is waiting on; a quit
	// must not be delayed by a retry that is 30 s out.
	tab.reconnectTimer.unref?.()
}

/**
 * The id of one device's terminal tab.
 * @param deviceId - the device the terminal belongs to.
 * @returns the tab id.
 */
function terminalTabId(deviceId) {
	return `${TERMINAL_PREFIX}${deviceId}`
}

/**
 * The tab one device's terminal lives in, created on first use.
 *
 * A terminal tab is **on demand**, unlike a device's Harness tab: a terminal is a
 * session, not a configured thing, and every device in the book having a second
 * permanent tab would double the bar for the one thing an operator opens
 * occasionally. It closes when the operator closes it and is not in the book.
 *
 * @param device - the device the terminal is for.
 * @returns the tab.
 */
function terminalTabFor(device) {
	const id = terminalTabId(device.id)
	const existing = tabs.get(id)
	if (existing !== undefined) {
		// The prefix is a convention, not a rule the book enforces. A device whose id
		// is `terminal:dev-a` gets one of these ids too, and overwriting the other
		// tab would hand a Harness tab's controls to a terminal. Refused, and the
		// caller reports it rather than deleting something.
		if (existing.kind !== 'terminal' || existing.deviceId !== device.id) {
			throw new Error(`the tab id "${id}" is already used by "${existing.label}"`)
		}
		existing.label = `${device.label} — terminal`
		return existing
	}
	const created = {
		id,
		kind: /** @type {'terminal'} */ ('terminal'),
		deviceId: device.id,
		label: `${device.label} — terminal`,
		state: /** @type {'idle'} */ ('idle'),
		generation: 0,
		lines: []
	}
	tabs.set(id, created)
	return created
}

/**
 * Cancel a terminal start that has not finished, wherever it is.
 *
 * The two stages are genuinely different: before the pty exists there is only the
 * platform probe to kill, and after it exists there is the ssh client. The
 * attempt's `stop` is replaced as the start moves from one to the other, so a `×`
 * works in both windows — the same problem `Attempt` solves for Harness connects,
 * with far less machinery because a terminal has no readiness line or tunnel.
 *
 * @param tab - the terminal tab being cancelled.
 */
function cancelTerminal(tab) {
	const attempt = tab.terminalAttempt
	if (attempt === undefined) return
	attempt.cancelled = true
	try {
		attempt.stop()
	} catch {
		/* the attempt is marked cancelled above either way */
	}
}

/**
 * Put a terminal's failure on its tab and tear down whatever it had started.
 * @param tab - the terminal tab.
 * @param attempt - the start this failure belongs to.
 * @param message - what the operator should read.
 */
function failTerminal(tab, attempt, message) {
	if (tab.terminalAttempt !== attempt) return
	attempt.stop()
	tab.terminal = undefined
	tab.state = 'failed'
	tab.error = message
	note(tab, `FAILED: ${message}`)
	publish()
}

/**
 * The two callbacks one terminal session reports through.
 *
 * The session is created with these and only assigned to the tab afterwards, so the
 * exit handler reads a box the assignment fills. A session that exits before that
 * assignment is a start that has not settled yet; calling it "ended" would overwrite
 * the start's own state with a result the operator cannot act on.
 *
 * @param tab - the tab the session belongs to.
 * @param generation - the generation these callbacks belong to.
 * @param box - holds the session once it exists.
 * @returns the callbacks.
 */
function terminalCallbacks(tab, generation, box) {
	return {
		onData: (data) => {
			// A replaced session's output belongs to the tab generation that owned it.
			// Delivering it into the replacement would interleave two terminals.
			if (tab.generation !== generation) return
			if (mainWindow === undefined || mainWindow.isDestroyed()) return
			mainWindow.webContents.send('terminal:data', { id: tab.id, data })
		},
		onExit: (status) => {
			if (tab.generation !== generation || tab.terminal !== box.session) return
			tab.exitCode = status.exitCode
			tab.state = 'ended'
			// **ssh's 255 on a password terminal is usually the password.** The pty
			// carries ssh's own sentence, so the tab still says what happened, but the
			// string in memory must not be replayed by the next ⟲: it was refused, and a
			// host with a lockout policy counts every replay. 255 also covers an
			// unreachable host, where asking again costs one dialog and nothing else.
			if (tab.passwordAuth === true && status.exitCode === 255) passwords.delete(tab.deviceId)
			publish()
		}
	}
}

/**
 * Start (or restart) one terminal tab's session.
 *
 * A terminal has no readiness line to wait for: ssh, or a local program, either
 * starts and hands over the terminal or prints why it could not and exits. So the
 * tab is `running` as soon as the pty exists, and a process that fails appears as
 * output followed by an `ended` tab with its exit code. What *is* awaited on the
 * device path is the shell family, because that decides the command to run, and it
 * is cached on the device after the first time.
 *
 * A password device's terminal asks for the same password its Harness tab asked
 * for, once per run. The pty cannot be where it is typed: the platform probe is a
 * second ssh client that runs before the terminal exists and has no pty at all, so
 * the password has to arrive through the askpass helper either way.
 *
 * @param tab - the terminal tab.
 * @param password - the password the operator just typed, if any.
 * @returns a password request when one is missing or was refused, otherwise undefined.
 */
async function startTerminal(tab, password) {
	if (tab.kind !== 'terminal') return
	/** @type {{cancelled: boolean, stop: () => void}} */
	const attempt = { cancelled: false, stop: () => {} }
	tab.terminalAttempt = attempt
	tab.generation = (tab.generation ?? 0) + 1
	tab.state = 'starting'
	tab.error = undefined
	tab.exitCode = undefined
	tab.attachRequested = false
	tab.lines = []
	publish()

	// A session that ends while its start is still on the stack must not overwrite
	// the state of a later attempt for the same tab.
	const generation = tab.generation

	try {
		// **A local terminal has no book to read and nothing to probe.** It is one
		// program in one directory, and the only way it fails is the resolution or the
		// pty itself — both of which throw the sentence the tab shows.
		if (tab.deviceId === undefined) {
			const box = { session: undefined }
			const session = terminal.startLocal({
				preset: tab.preset,
				cwd: tab.cwd,
				...terminalCallbacks(tab, generation, box)
			})
			box.session = session
			if (attempt.cancelled) {
				session.kill()
				return
			}
			tab.terminal = session
			attempt.stop = () => {
				session.kill()
			}
			tab.state = 'running'
			publish()
			if (tab.attachRequested === true) session.attach()
			return
		}

		const stored = await devices.load()
		if (attempt.cancelled) return
		const device = stored.find((entry) => entry.id === tab.deviceId)
		if (device === undefined) {
			failTerminal(tab, attempt, 'this device is no longer in the book')
			return
		}
		tab.label = `${device.label} — terminal`

		// Settled before the probe, for the same reason `activate` settles it before
		// the first spawn: a probe with no credential is a `Permission denied` for a
		// password nobody has typed yet.
		const secret = passwordFor(device, password)
		if (device.auth === 'password' && secret === undefined) {
			tab.state = 'idle'
			publish()
			return passwordPrompt(device)
		}
		tab.passwordAuth = device.auth === 'password'
		const authEnv = secret === undefined ? undefined : askpass.envFor(secret, askpassDirectory())

		let platform = device.platform
		if (platform === undefined) {
			const ssh = connect.sshExecutable()
			const detected = await connect.detectPlatform(device, ssh, (line) => note(tab, line), (probe) => {
				if (attempt.cancelled) {
					try {
						probe.kill()
					} catch {
						/* already gone */
					}
					return false
				}
				attempt.stop = () => {
					try {
						probe.kill()
					} catch {
						/* already gone */
					}
				}
				return true
			}, authEnv)
			if (attempt.cancelled) return
			if (detected.error !== undefined) {
				failTerminal(tab, attempt, detected.error)
				if (device.auth === 'password' && askpass.isAuthFailure(detected.error)) {
					passwords.delete(device.id)
					return passwordPrompt(device, detected.error)
				}
				return
			}
			platform = detected.platform
			if (device.platform !== platform) {
				device.platform = platform
				await persistPlatform(device)
			}
			if (attempt.cancelled) return
		}

		const box = { session: undefined }
		const session = terminal.start({
			device,
			platform,
			ssh: connect.sshExecutable(),
			...(secret === undefined ? {} : { password: secret, askpassDir: askpassDirectory() }),
			...terminalCallbacks(tab, generation, box)
		})
		box.session = session
		if (attempt.cancelled) {
			session.kill()
			return
		}
		tab.terminal = session
		attempt.stop = () => {
			session.kill()
		}
		tab.state = 'running'
		publish()
		// The renderer may have attached while the platform probe was running; the
		// session could not be attached to then because it did not exist yet.
		if (tab.attachRequested === true) session.attach()
	} catch (error) {
		if (attempt.cancelled) return
		failTerminal(tab, attempt, error instanceof Error ? error.message : String(error))
	} finally {
		if (tab.terminalAttempt === attempt) tab.terminalAttempt = undefined
	}
}

/**
 * Show a terminal tab, starting its session when there is nothing to show.
 * @param tab - the terminal tab.
 * @param password - the password the operator just typed, if any.
 * @returns a password request when the session cannot start without one.
 */
async function activateTerminal(tab, password) {
	activeId = tab.id
	if (tab.state === 'running' || tab.state === 'starting') {
		publish()
		return
	}
	return await startTerminal(tab, password)
}

/**
 * Open (or focus) one device's terminal from the popover.
 * @param deviceId - the device id.
 * @param password - the password the operator just typed, if any.
 * @returns a password request when the session cannot start without one.
 */
async function openTerminal(deviceId, password) {
	const stored = await devices.load()
	const device = stored.find((entry) => entry.id === String(deviceId))
	if (device === undefined) return
	let tab
	try {
		tab = terminalTabFor(device)
	} catch (error) {
		// There is no tab to draw a collision on — the id belongs to another tab —
		// so the console is the only place left to say it. The case needs a device
		// renamed to this application's own prefix by hand.
		console.error(`[terminal] ${error instanceof Error ? error.message : String(error)}`)
		return
	}
	return await activateTerminal(tab, password)
}

/**
 * The name a local tab carries.
 *
 * The folder is part of the label because two `pi` tabs in two projects are two
 * different conversations, and a bar full of identical "pi" tabs says nothing.
 *
 * @param preset - the program's preset.
 * @param cwd - its directory.
 * @returns the label.
 */
function localTerminalLabel(preset, cwd) {
	const name = preset === 'shell' ? 'Shell' : preset
	const folder = cwd === homedir() ? 'home' : basename(cwd) || cwd
	return `${name} — ${folder}`
}

/**
 * Ask for the directory one local program should start in.
 *
 * `lastDirectory` is the default rather than the home directory, because a coding
 * agent is opened in a project and the next one is usually beside it. A cancelled
 * dialog is not an error — it is the operator changing their mind — so the answer
 * is `undefined` rather than an exception.
 *
 * @param title - what the dialog is for.
 * @returns the chosen directory, or undefined.
 */
async function chooseDirectory(title) {
	const options = { title, defaultPath: lastDirectory, properties: ['openDirectory'] }
	let result
	try {
		result =
			mainWindow === undefined || mainWindow.isDestroyed()
				? await dialog.showOpenDialog(options)
				: await dialog.showOpenDialog(mainWindow, options)
	} catch (error) {
		console.error(`[terminal] the folder chooser failed: ${error instanceof Error ? error.message : String(error)}`)
		return undefined
	}
	if (result === undefined || result.canceled === true) return undefined
	if (!Array.isArray(result.filePaths) || result.filePaths.length === 0) return undefined
	const chosen = result.filePaths[0]
	if (typeof chosen !== 'string' || chosen === '') return undefined
	lastDirectory = chosen
	return chosen
}

/**
 * Open one program on this machine in a terminal tab.
 *
 * The tab exists before the session does, like every terminal here, so a start that
 * fails has somewhere to put its reason and a `⟲` to try again. A preset that is not
 * installed fails in `startLocal` and the tab says which program was missing — which
 * is also why the popover asks `listPresets` first and disables the button.
 *
 * @param preset - the program's preset.
 */
async function openLocalTerminal(preset) {
	if (!terminal.PRESETS.some((entry) => entry.id === preset)) return
	let cwd = homedir()
	if (preset !== 'shell') {
		const chosen = await chooseDirectory(`Where should ${preset} start?`)
		if (chosen === undefined) return
		cwd = chosen
	}
	let id
	do {
		id = `${TERMINAL_PREFIX}local:${randomUUID()}`
	} while (tabs.has(id))
	/** @type {Tab} */
	const tab = {
		id,
		kind: 'terminal',
		preset,
		cwd,
		label: localTerminalLabel(preset, cwd),
		state: 'idle',
		generation: 0,
		lines: []
	}
	tabs.set(id, tab)
	await activateTerminal(tab)
}

/**
 * Reconnect a terminal in place, keeping its tab.
 * @param tab - the terminal tab.
 * @param password - the password the operator just typed, if any.
 * @returns a password request when the session cannot start without one.
 */
async function restartTerminal(tab, password) {
	cancelTerminal(tab)
	const session = tab.terminal
	tab.terminal = undefined
	tab.state = 'idle'
	if (session !== undefined) session.kill()
	publish()
	return await startTerminal(tab, password)
}

/**
 * Close a terminal tab and its session.
 *
 * This is the `×` on the tab, and it is deliberately different from the `×` on a
 * Harness tab: a device tab stays in the bar because the device is configured, but
 * a terminal is an open session and closing it is how it ends.
 *
 * @param tab - the terminal tab.
 */
function closeTerminalTab(tab) {
	cancelTerminal(tab)
	const session = tab.terminal
	tab.terminal = undefined
	if (session !== undefined) session.kill()
	tabs.delete(tab.id)
	if (activeId === tab.id) {
		activeId = tab.deviceId !== undefined && tabs.has(tab.deviceId) ? tab.deviceId : LOCAL_ID
	}
	publish()
}

/**
 * How long a teardown may take to be noticed before a restart goes ahead anyway.
 *
 * A local Harness is reaped by `taskkill /T /F`, which is synchronous and takes tens
 * of milliseconds; a remote one by the far side reading EOF, which is a round trip.
 * This is the ceiling for the whole wait, not a delay anybody sits through — both
 * paths settle well inside it, and a teardown that does not is reported rather than
 * waited on for ever.
 */
const RESTART_SETTLE_MS = 5_000

/**
 * How often the wait looks again, and the *only* latency a clean restart pays.
 *
 * A running Harness is killed inside the same tick as the stop, so there is nothing
 * to wait for except Node delivering the child's `exit` — which is what the first
 * check-and-turn below covers. This interval is for the case where the process really
 * is taking its time.
 */
const RESTART_POLL_MS = 50

/**
 * How long a persistent tab waits before re-opening the tunnel it lost.
 *
 * A tunnel is the one part of a persistent connection that *is* this
 * application's: the host behind it is not. So losing it is a state to come back
 * from, not a failure to report — a laptop lid, a Wi-Fi handover, or a `ssh`
 * that was killed. The page is kept in the meantime and its own transport retries
 * at 500 ms → 10 s, so a tunnel that returns inside a minute is invisible.
 *
 * Doubling, capped, with no attempt limit: the tab exists until the operator
 * closes it, and a cap on attempts would mean a tab that quietly stops trying.
 */
const RECONNECT_BASE_MS = 1_000

/** The ceiling the doubling stops at, so a long outage costs one ssh a minute. */
const RECONNECT_MAX_MS = 30_000

/**
 * Wait until the process a tab was serving from has actually gone.
 *
 * **A stop that returns before the process is dead makes a restart a race, and the
 * race is the whole complaint.** `stopTab` hands the teardown to the connect path,
 * which ends the shell's stdin and tree-kills it on Windows — but the kill is
 * asynchronous from the Harness's point of view, and a replacement started in the
 * same tick competes with the old process for the session store, the git index and
 * whatever else it held. On a remote tab the wait has a second job: the far-side
 * `dsh web` is reaped by EOF on a pipe, which needs the round trip to happen.
 *
 * The condition is the connection's own liveness — the same one the `onServerExit`
 * watcher uses to decide a tab has died — so this cannot disagree with the tab's
 * state about whether anything is still there. Polling rather than an event listener
 * because the listener is registered by `activate` for a connection this function no
 * longer owns, and a restart must not depend on that having happened.
 *
 * **The shape is check, then turn, then check again — not check, sleep, check.** A
 * child that is already dead must cost one event-loop turn rather than one interval:
 * otherwise every restart of a healthy Harness is 50 ms of a window that is already
 * down and a tab that says "starting" in the meantime, which is exactly the
 * sluggishness that makes an operator press the control twice.
 *
 * @param connection - the connection that was just stopped.
 * @returns whether it was gone before the ceiling.
 */
async function settled(connection) {
	if (connection === undefined || typeof connection.stillRunning !== 'function') return true
	const deadline = Date.now() + RESTART_SETTLE_MS
	const turn = () =>
		new Promise((resolve) => {
			setTimeout(resolve, RESTART_POLL_MS)
		})
	for (;;) {
		if (!connection.stillRunning()) return true
		// The turn before the re-check is what lets `exit` be delivered: a kill and a
		// poll in the same tick would see `exitCode === null` for a process that is
		// already gone.
		await turn()
		if (!connection.stillRunning()) return true
		if (Date.now() > deadline) return false
	}
}

/**
 * Stop one tab and bring it straight back up — the operation the operator used to
 * have to quit the whole application to perform.
 *
 * **Why this exists rather than "close the window and open it again".** The local
 * Harness is a child process of this application, so restarting it means stopping it
 * and starting it, and until now the only control that stopped it was the `×` on a
 * device tab — the local tab had none, on purpose, because nothing recreated it. So
 * the documented way to pick up a change in the Harness or its profile was to close
 * the desktop and launch it again, which is both heavier than the operation and the
 * moment a stale process gets left behind if the close does not go cleanly.
 *
 * The order is the contract: stop, wait for the process to be gone, then connect.
 * Starting before the old one has exited is what makes "restart" look like it did
 * nothing — the operator's next turn lands on the old process, and the session they
 * meant to replace is still the one answering. When the wait runs out the connect
 * goes ahead anyway, because a refused restart would be worse than a stale backend,
 * and the transcript says which of the two happened.
 *
 * **That line is written after the connect, not before it, and that is not a style
 * choice.** `activate` clears the tab's transcript before it starts — a tab's lines
 * are the story of the attempt that is running — so a note written before the wait is
 * erased by the very connect it was describing. Measured: the line was in the buffer
 * while the old process was being waited for and gone by the time the tab was up,
 * which is when the operator reads it.
 *
 * A click that arrives during the wait is not a second Harness: `activate` returns
 * immediately for a tab that is already `starting`, so whichever of the two gets
 * there first is the only connect.
 *
 * @param id - the tab to restart.
 * @param password - the password the operator just typed, if any.
 * @returns a password request when the connect cannot start without one.
 */
async function restartTab(id, password) {
	const tab = tabs.get(id)
	if (tab === undefined) return
	const wasRunning = tab.state === 'running' || tab.state === 'starting' || tab.state === 'detached'
	const connection = tab.connection
	// A restart is the one thing that *does* end a persistent host's process: the
	// operator asked for a different one, and adopting the old one would answer the
	// wrong question. Everything else detaches.
	stopTab(tab, { terminate: true })
	publish()
	if (!wasRunning) {
		// A tab that was idle or failed has nothing to wait for: the operator asking
		// to restart a tab that is down is asking to start it.
		return await activate(id, password)
	}
	const gone = await settled(connection)
	if (tabs.get(id) !== tab) return
	const prompt = await activate(id, password)
	// Only when the tab is genuinely up: a connect that failed already put its own
	// reason in the transcript, and a line about the teardown underneath it would be
	// the wrong last word.
	if (!gone && tab.state === 'running') {
		note(tab, `the previous process was still alive after ${String(RESTART_SETTLE_MS / 1000)}s; started anyway`)
		publish()
	}
	return prompt
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
 * Empty one Harness tab's guest session before it is given a new Harness to show.
 *
 * **The cookie is per connection, so the jar is reset per connection.** The cookie
 * `dsh web` mints names the authority — `host:port` — of the process that minted it,
 * and the next connect starts a *new* process on a *new* port, so every cookie left
 * in this tab's session by the previous connection is already dead. `guestPartition`
 * keeps that session private to the tab; this is what keeps it bounded: a tab
 * carries at most the one cookie its current connection set, however many times the
 * operator restarts it, and the Cookie header can never grow with the application's
 * history again.
 *
 * **It is not a shared cleanup, which is why it is safe.** Every Harness tab has a
 * partition of its own, so this cannot sign out a tab somebody is using — the other
 * half of why the fix was not "delete stale cookies from the default session".
 *
 * @param partition - the tab's session partition.
 */
async function clearGuestSession(partition) {
	// A stub Electron — the offline suites, and node mode before the diagnosis
	// fires — has no session module. Nothing in a connect depends on the clear.
	if (session === undefined) return
	try {
		await session.fromPartition(partition).clearStorageData({ storages: ['cookies'] })
	} catch {
		/* A guard, not a step: the guest still starts in a session of its own, and a
		   clear that was refused only means the previous connection's cookie is still
		   there. The connect must not fail over housekeeping. */
	}
}

/**
 * Remove the authentication cookies earlier builds left in the window's own session.
 *
 * **This is history, not a live path.** Before guests had partitions they all ran in
 * the default, persistent session, so its jar grew with every Harness that had ever
 * been opened — 70 cookies and 15,750 bytes on this machine on 2026-11-21, which is
 * what produced the `431` blank windows. Nothing reads that jar any more, but the
 * cookies are still in the operator's profile, and removing them at boot is what
 * makes it healthy rather than merely unused: a build that predates `guestPartition`
 * is one launch away from a regression, and anything else that ever attaches a
 * guest without one would inherit the same jar.
 *
 * Only the `dsh-auth-` cookies are touched, each removed on its own, and a failure is
 * not fatal: this is housekeeping that must never be able to stop the local Harness
 * from coming up.
 */
async function clearLegacyGuestCookies() {
	if (session === undefined) return
	try {
		const stored = await session.defaultSession.cookies.get({})
		for (const cookie of stored) {
			if (!cookie.name.startsWith(AUTH_COOKIE_PREFIX)) continue
			const host = String(cookie.domain ?? '').replace(/^\./u, '')
			if (host === '') continue
			const path = cookie.path === undefined || cookie.path === '' ? '/' : cookie.path
			try {
				await session.defaultSession.cookies.remove(`${cookie.secure === true ? 'https' : 'http'}://${host}${path}`, cookie.name)
			} catch {
				/* One cookie that refuses to go is not worth failing the boot for. */
			}
		}
	} catch {
		/* A session module that cannot be read is a build this does not apply to. */
	}
}

/**
 * Bring a tab to the front, and start nothing.
 *
 * **Selecting a tab is not asking for a connection.** A device tab is a configured
 * thing that stays in the bar whether it is up or down, and switching past one on the
 * way to another used to start a Harness on somebody else's machine — a side effect
 * the operator never asked for and could only undo by finding `×`. The Android client
 * has always drawn this line the same way: a tab shows CONNECT until it is pressed.
 *
 * So this is what a click and Alt+digit do; `activate` is the separate, deliberate
 * operation, reached from the panel's CONNECT, from Try again, and from `⟲`.
 *
 * @param id - the tab id.
 */
function select(id) {
	if (tabs.get(id) === undefined) return
	activeId = id
	publish()
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
 * @param password - the password the operator just typed, if any.
 * @returns a password request when the device needs one, otherwise undefined.
 */
async function activate(id, password) {
	const tab = tabs.get(id)
	if (tab === undefined) return
	// A terminal's "activate" is its start: the tab exists because the operator
	// asked for a session, and re-entering it from the panel or Alt+digit is the
	// same request. Its state machine has no connect result to wait on.
	if (tab.kind === 'terminal') {
		return await activateTerminal(tab, password)
	}
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
		/** @type {Record<string, any> | undefined} */
		let device
		if (tab.kind !== 'local') {
			const stored = await devices.load()
			if (abandoned(tab, attempt)) return
			device = stored.find((entry) => entry.id === id)
			if (device === undefined) {
				tab.state = 'failed'
				tab.error = 'this device is no longer in the book'
				tab.lines.push('FAILED: this device is no longer in the book')
				publish()
				return
			}
		}

		// **The password is settled before anything is spawned.** A device that
		// authenticates by password and has none for this run is not a connect that
		// fails — it is a question that has not been answered yet. Returning here,
		// with the attempt cancelled and the tab back to idle, is what lets the
		// renderer open its dialog and call again with the answer; spawning ssh
		// first would print `Permission denied` for a password nobody has typed.
		const secret = passwordFor(device, password)
		if (device !== undefined && device.auth === 'password' && secret === undefined) {
			cancelAttempt(tab)
			tab.activation = undefined
			tab.state = 'idle'
			tab.error = undefined
			publish()
			return passwordPrompt(device)
		}

		// **The guest's session is emptied before the Harness it will show is
		// started — unless the origin provably did not change.** The auth cookie a
		// `dsh web` mints names the authority of *its own* process (`host:port`), so
		// after a restart every cookie this tab's session holds belongs to a
		// connection that is already gone. Clearing first is what keeps the tab's
		// Cookie header at one cookie instead of one per restart — see
		// `clearGuestSession` and `GUEST_PARTITION_PREFIX` for the failure that came of
		// not doing it.
		//
		// A persistent device is the one case where the authority is deliberately
		// stable: the same local port, the same host behind it. There the jar and the
		// page's own storage are the things that make a reconnect land back in the same
		// Session, so clearing them is the bug rather than the cure. The condition is
		// an equality rather than "persistent", because a device that has no fixed port
		// still gets a new origin every time and must be cleared like any other.
		const persistent = device?.mode === 'persistent'
		const sameOrigin = persistent === true && tab.localPort !== undefined && tab.localPort === device?.localPort
		if (!sameOrigin) await clearGuestSession(guestPartition(tab.id))
		if (abandoned(tab, attempt)) return

		/** @type {{url?: string, error?: string} & Record<string, unknown>} */
		let result
		if (tab.kind === 'local') {
			// The local tab's own launch directory is not a device field, and the book
			// is not read for it at all: after the session clear above there is nothing
			// between here and the spawn that could change the operator's mind.
			result = await runConnect((onChild) =>
				connect.connectLocal({
					signal,
					onLine: (line) => note(tab, line),
					onChild
				})
			)
		} else {
			result = await runConnect((onChild) =>
				connect.connectRemote(/** @type {any} */ (device), {
					signal,
					onLine: (line) => note(tab, line),
					onChild,
					...(secret === undefined ? {} : { password: secret, askpassDir: askpassDirectory() })
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
			// **A failed connect must not leave what it had already handed over.**
			// `connectRemote` registers a teardown for every child the moment it is
			// spawned, and `runConnect` turns a throw into this result — but until this
			// call existed, the only teardown on the failure path was the one the
			// connect path had already run by hand. A throw *after* the server ssh was
			// spawned therefore left the ssh client and the far side's `dsh web` alive
			// with no tab holding them. `cancelAttempt` is idempotent: the ordinary
			// failure paths have already stopped their children, and stopping a closed
			// pipe or an ended pid again is a no-op.
			cancelAttempt(tab)
			tab.state = 'failed'
			tab.error = result.error
			note(tab, `FAILED: ${result.error}`)
			publish()
			// **A refused password is forgotten and asked for again; nothing else is.**
			// `isAuthFailure` is deliberately narrow — a timeout or a changed host key
			// must not throw away a password that was fine — and a refusal is the one
			// answer that means the string in memory is wrong rather than stale.
			if (device !== undefined && device.auth === 'password' && askpass.isAuthFailure(result.error)) {
				passwords.delete(device.id)
				return passwordPrompt(device, result.error)
			}
			return
		}

		tab.connection = /** @type {Tab['connection']} */ (result)
		tab.url = result.url
		tab.state = 'running'
		// What the tab is, for everything that has to decide how far it may go: a
		// persistent tab keeps its page and its host when the connection ends.
		tab.persistent = result.persistent === true
		tab.adopted = result.adopted === true
		tab.platform = result.platform
		tab.localPort = result.persistent === true ? result.localPort : undefined
		tab.reconnectAttempt = 0
		// What every tab's transcript says about its own URL. The wording used to be
		// "local URL", which was a lie on a remote tab and sent at least one reader
		// looking for a remote port that the tunnel does not use.
		note(tab, `URL: ${result.url}`)
		if (tab.persistent === true) note(tab, tab.adopted === true ? 'host adopted: the Sessions it holds are the ones you left' : 'host started: it will outlive this connection')

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
			if (tab.connection !== result) return
			if (tab.persistent === true) {
				// **The host is not this connection's to lose.** Only the forward ended,
				// so this is a state to come back from: keep the page, keep the URL, and
				// come back on the same local port so the page's own transport retry
				// lands on the same origin and the same Session.
				tab.connection = undefined
				tab.state = 'detached'
				note(tab, `the ssh tunnel ended (code ${String(code)})`)
				scheduleReconnect(tab)
				publish()
				return
			}
			if (tab.state !== 'running') return
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
		// A rename reaches the terminal tab too, or the bar keeps the old name on a
		// session the operator just opened from the renamed row.
		const terminalTab = tabs.get(terminalTabId(device.id))
		if (terminalTab !== undefined && terminalTab.kind === 'terminal') {
			terminalTab.label = `${device.label} — terminal`
		}
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
		// Selection only: Alt+digit is how an operator moves around the bar, and
		// moving past a sleeping tab must not wake it. See `select`.
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

/**
 * The electron-updater instance, loaded only when an update is actually checked.
 *
 * **Lazy on purpose.** `tools/main.mjs` loads this file with an Electron stub that
 * has no updater and no resources path, and a top-level `require('electron-updater')`
 * would initialize a module that needs a packaged application. The installed build
 * is the only one that can check, and only its first check pays for the load.
 *
 * @type {import('electron-updater').AppUpdater | undefined}
 */
let autoUpdater

/** True while a download is in flight, so a second check cannot start another one. */
let updating = false

/**
 * Whether this build has an update feed to ask.
 *
 * `electron-updater` needs the `app-update.yml` that `electron-builder` writes into
 * `resources/`. A build from source, and the unpacked directory an earlier
 * `electron-packager` produced, do not have one; saying so is better than a dialog
 * about a missing file.
 *
 * @returns true when a check can be made.
 */
function updateFeedAvailable() {
	return app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))
}

/**
 * Show a message box, over the window when there is one.
 * @param options - the dialog options.
 * @returns the chosen button.
 */
function showBox(options) {
	if (mainWindow !== undefined && !mainWindow.isDestroyed()) return dialog.showMessageBox(mainWindow, options)
	return dialog.showMessageBox(options)
}

/**
 * Load and configure `electron-updater`, once.
 *
 * **The download is the operator's decision.** `autoDownload` is off; the check
 * offers a button and nothing is fetched until it is pressed. A downloaded update
 * installs when the application quits (`autoInstallOnAppQuit`), so choosing "Later"
 * is not choosing to throw it away.
 *
 * @returns the configured updater.
 */
function updater() {
	if (autoUpdater !== undefined) return autoUpdater
	const module = require('electron-updater')
	autoUpdater = module.autoUpdater
	autoUpdater.autoDownload = false
	autoUpdater.autoInstallOnAppQuit = true
	autoUpdater.on('download-progress', (progress) => {
		if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.setProgressBar(progress.percent / 100)
	})
	autoUpdater.on('update-downloaded', async (info) => {
		updating = false
		if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1)
		const answer = await showBox({
			type: 'info',
			message: `dsh-tabs ${String(info.version)} has been downloaded`,
			detail: 'Restart to install it now, or it will install when you quit.',
			buttons: ['Restart and install', 'Later'],
			defaultId: 0,
			cancelId: 1,
			noLink: true
		})
		if (answer.response === 0) autoUpdater.quitAndInstall(false, true)
	})
	autoUpdater.on('error', (error) => {
		updating = false
		if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1)
		console.error(`[updater] ${error instanceof Error ? error.message : String(error)}`)
	})
	return autoUpdater
}

/**
 * Ask the release feed, and offer a download when it names a newer version.
 *
 * @param automatic - the launch check, which reports nothing unless an update exists.
 */
async function checkForUpdates(automatic) {
	if (!updateFeedAvailable()) {
		if (!automatic) {
			await showBox({
				type: 'info',
				message: 'Updates are not available in this build',
				detail: 'This copy has no update feed. Install the 0.2.0 installer once, and later versions will update from inside the app.',
				buttons: ['OK'],
				noLink: true
			})
		}
		return
	}
	if (updating) {
		if (!automatic) {
			await showBox({ type: 'info', message: 'An update is already downloading', buttons: ['OK'], noLink: true })
		}
		return
	}
	try {
		const result = await updater().checkForUpdates()
		const latest = result?.updateInfo?.version
		if (latest === undefined || localdsh.compareVersions(latest, app.getVersion()) <= 0) {
			if (!automatic) {
				await showBox({ type: 'info', message: `dsh-tabs ${app.getVersion()} is up to date`, buttons: ['OK'], noLink: true })
			}
			return
		}
		const notes = typeof result.updateInfo.releaseNotes === 'string' ? result.updateInfo.releaseNotes : ''
		const answer = await showBox({
			type: 'info',
			message: `dsh-tabs ${String(latest)} is available`,
			detail: notes.slice(0, 1500) || 'A new version is available. Download it now?',
			buttons: ['Download', 'Later'],
			defaultId: 0,
			cancelId: 1,
			noLink: true
		})
		if (answer.response !== 0) return
		updating = true
		if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.setProgressBar(0)
		try {
			await updater().downloadUpdate()
		} catch (error) {
			updating = false
			if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1)
			await showBox({
				type: 'error',
				message: 'The update could not be downloaded',
				detail: error instanceof Error ? error.message : String(error),
				buttons: ['OK'],
				noLink: true
			})
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		if (!automatic) {
			await showBox({
				type: 'error',
				message: 'Could not check for updates',
				detail: reason,
				buttons: ['OK'],
				noLink: true
			})
		} else {
			console.error(`[updater] ${reason}`)
		}
	}
}

/** Wire the renderer's requests. */
function installIpc() {
	ipcMain.handle('tabs:get', () => snapshot())
	ipcMain.handle('tabs:activate', async (_event, id, password) => {
		const prompt = await activate(String(id), typeof password === 'string' ? password : undefined)
		return { ...snapshot(), ...(prompt === undefined ? {} : { needsPassword: prompt }) }
	})
	// The selection half, which a click and Alt+digit use: show the tab, start
	// nothing. Keeping the two apart is what makes "show me that tab" and "start
	// that machine" different requests.
	ipcMain.handle('tabs:select', async (_event, id) => {
		select(String(id))
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
			// A terminal's `×` is a close: the tab is a session, not a device, and
			// there is nothing left to show after its shell has gone. A Harness tab
			// keeps its place in the bar because the device is configured.
			if (tab.kind === 'terminal') {
				closeTerminalTab(tab)
				return snapshot()
			}
			// A persistent tab's `×` lets go of the forward and keeps the host: the
			// page stays, the Session stays, and opening the tab again adopts the same
			// process. Killing it would make the mode a longer way to do nothing.
			stopTab(tab, { keepPage: tab.persistent === true })
			publish()
		}
		return snapshot()
	})
	ipcMain.handle('tabs:restart', async (_event, id, password) => {
		// The operation this application used to make the operator quit for. Awaited
		// rather than fired and forgotten: the whole point is that the tab comes back,
		// and the renderer draws whatever state it is in when this resolves — so a
		// restart that failed is on screen as a failure rather than as a tab that
		// looks like it is still coming up.
		const key = String(id)
		const tab = tabs.get(key)
		let prompt
		if (tab !== undefined && tab.kind === 'terminal') {
			prompt = await restartTerminal(tab, typeof password === 'string' ? password : undefined)
		} else {
			prompt = await restartTab(key, typeof password === 'string' ? password : undefined)
		}
		return { ...snapshot(), ...(prompt === undefined ? {} : { needsPassword: prompt }) }
	})
	ipcMain.handle('tabs:reap', async (_event, id) => {
		// **The one control that ends a persistent host.** Everything else detaches,
		// because the host may be serving another client — a phone, a second window —
		// and the work it is doing belongs to somebody else. So this is only ever
		// reached from an explicit operator action, and it is awaited so the tab can
		// show what the far side said.
		const key = String(id)
		if (key === LOCAL_ID) return snapshot()
		const tab = tabs.get(key)
		if (tab === undefined || tab.kind !== 'remote') return snapshot()
		const platform = tab.platform ?? 'posix'
		const stored = await devices.load()
		const device = stored.find((entry) => entry.id === key)
		const connection = tab.connection
		// A password device whose password this run has not been told cannot run the
		// stop program: the only ssh connection available to it would be refused. Say
		// so instead of letting the spawn fail with `Permission denied`, which reads
		// like the far side is broken rather than the window's memory empty.
		if (device !== undefined && device.auth === 'password' && passwords.get(key) === undefined) {
			note(tab, 'FAILED: stopping the host needs this machine\'s password; connect with it once first')
			publish()
			return snapshot()
		}
		tab.connection = undefined
		cancelReconnect(tab)
		try {
			if (connection !== undefined && typeof connection.terminate === 'function') {
				await connection.terminate()
			} else if (device !== undefined) {
				// A detached tab has no connection to terminate, so the record on the far
				// side is what is stopped — which is also the case that reaches a host
				// this window adopted rather than started.
				await connect.stopHost(device, platform, {
					onLine: (line) => note(tab, line),
					...(device.auth === 'password' ? { password: passwords.get(key), askpassDir: askpassDirectory() } : {})
				})
			}
		} catch (error) {
			note(tab, `FAILED: ${error instanceof Error ? error.message : String(error)}`)
		}
		tab.url = undefined
		tab.state = 'idle'
		tab.persistent = undefined
		tab.adopted = undefined
		tab.localPort = undefined
		publish()
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
		// Switching a device back to its key makes the remembered password dead
		// weight and, worse, a secret in memory for a machine that no longer uses one.
		if (saved !== undefined && saved.auth !== 'password') passwords.delete(saved.id)
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
		// A terminal tab belongs to the device and would otherwise outlive it: the
		// label would name a machine that is no longer in the book, and the ssh
		// client would keep running with nothing left that could name it.
		const terminalTab = tabs.get(terminalTabId(key))
		if (terminalTab !== undefined) closeTerminalTab(terminalTab)
		const tab = tabs.get(key)
		if (tab !== undefined) {
			// Before the tab leaves the map, which is what makes the connect in flight
			// findable: `stopTab` tears the attempt down *and* the settled connection,
			// and `tabs.delete` afterwards leaves the attempt nothing to come back to.
			// Removing the device is an explicit "I am done with this machine", so the
			// host goes too — the one path besides a restart that ends a process.
			stopTab(tab, { terminate: true })
			tabs.delete(key)
		}
		const stored = await devices.mutate((current) => current.filter((entry) => entry.id !== key))
		if (activeId === key) activeId = LOCAL_ID
		// The password is the one thing about a device this run holds outside the
		// book; removing the device has to remove it too, or it would sit in memory
		// until a quit for a machine the operator has deleted.
		passwords.delete(key)
		publish()
		return { devices: stored }
	})
	ipcMain.handle('devices:transcript', (_event, id) => {
		const tab = tabs.get(String(id))
		return { lines: tab === undefined ? [] : tab.lines }
	})
	// The popover asks what can be opened before it draws the buttons: a missing
	// `pi` becomes a disabled control carrying the reason, not a folder chooser that
	// ends in a failure.
	ipcMain.handle('terminal:presets', () => ({ presets: terminal.listPresets() }))
	// Opening a terminal is a deliberate request, unlike selecting a tab: the
	// operator pressed a control that says Terminal, so the session starts.
	ipcMain.handle('terminal:openLocal', async (_event, preset) => {
		await openLocalTerminal(String(preset))
		return snapshot()
	})
	ipcMain.handle('terminal:open', async (_event, deviceId, password) => {
		const prompt = await openTerminal(String(deviceId), typeof password === 'string' ? password : undefined)
		return { ...snapshot(), ...(prompt === undefined ? {} : { needsPassword: prompt }) }
	})
	// The renderer has an xterm for this tab and is ready to draw. Until this
	// arrives the session holds its output, because the first thing a failing ssh
	// prints is the reason, and it prints it inside this window.
	ipcMain.handle('terminal:attach', (_event, id) => {
		const tab = tabs.get(String(id))
		if (tab === undefined || tab.kind !== 'terminal') return
		tab.attachRequested = true
		tab.terminal?.attach()
	})
	// Keystrokes and sizes are hot: `invoke` would put a promise on every key. The
	// two channels are one-way and the handler validates what it accepts, so a
	// renderer bug cannot reach a pty with a value it did not expect.
	ipcMain.on('terminal:input', (_event, id, data) => {
		const tab = tabs.get(String(id))
		if (tab === undefined || tab.kind !== 'terminal' || typeof data !== 'string') return
		if (data.length > 1_000_000) return
		tab.terminal?.write(data)
	})
	ipcMain.on('terminal:resize', (_event, id, cols, rows) => {
		const tab = tabs.get(String(id))
		if (tab === undefined || tab.kind !== 'terminal') return
		tab.terminal?.resize(Number(cols), Number(rows))
	})
	// The clipboard belongs to the main process. `clipboard` is not among the
	// modules a preload gets from `require('electron')`, so exposing it from there
	// was a runtime `undefined` that only a click could find; the preload asks here
	// instead, and the renderer's calls are promises.
	ipcMain.handle('clipboard:read', () => clipboard.readText())
	ipcMain.handle('clipboard:write', (_event, text) => {
		clipboard.writeText(String(text ?? ''))
	})
	ipcMain.handle('updates:check', async () => {
		await checkForUpdates(false)
		return { version: app.getVersion() }
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
		// The session jar that earlier builds grew belongs to no guest any more; it is
		// removed before the window exists so the first Harness tab starts on a clean
		// profile rather than beside a 15 KB Cookie header. See
		// `clearLegacyGuestCookies`.
		await clearLegacyGuestCookies()
		createWindow()
		// The local Harness is what the operator opens the app for, so it comes up
		// without being asked. A remote device waits to be selected.
		await activate(LOCAL_ID)
		// The launch check waits ten seconds: the local Harness is what the operator
		// opened the application for, and an update dialog must not compete with it.
		// The timer is unref'd so a failed boot, or a suite that loads this file, is
		// not held open by a check that has not run yet.
		const updateTimer = setTimeout(() => {
			void checkForUpdates(true)
		}, 10_000)
		updateTimer.unref()
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
		for (const tab of tabs.values()) stopTab(tab, { keepPage: tab.persistent === true })
	})
}
