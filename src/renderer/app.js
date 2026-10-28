'use strict'

/**
 * The window chrome: a tab bar that is always visible, and one `<webview>` per
 * running tab underneath it.
 *
 * The bar is drawn here but the shortcuts are not: Alt+1…9 is handled in the
 * main process, because key events do not cross into a `<webview>` guest and the
 * operator's focus is almost always inside one. This file only listens for the
 * main process telling it which tab won.
 */

const api = globalThis.dshTabs

const tabsEl = document.getElementById('tabs')
const contentEl = document.getElementById('content')
const popoverEl = document.getElementById('popover')
const addEl = document.getElementById('add')

/** Live `<webview>` elements keyed by tab id, with the URL each one was built for. */
const views = new Map()

/** The last state the main process pushed. */
let state = { tabs: [], activeId: 'local' }

/** Cached device list, for the popover. */
let devices = []

/**
 * Tell CSS which platform this is.
 *
 * The tab bar doubles as the window chrome, so on Windows and Linux the OS draws
 * its window controls over the bar's right end and the strip has to stop short of
 * them. That is a static width per platform, and it is applied through a **data
 * attribute** rather than an inline style on purpose.
 *
 * This page's own `style-src` forbids inline style mutation — a
 * `style.setProperty()` or a bare `style.width = …` is blocked, and blocked
 * *silently*. The measurement that used to live here did exactly that, so the
 * reservation never applied and the last tab sat underneath the close button. No
 * offline check could see it; it surfaced the first time the app was actually run
 * with the renderer's console forwarded to the terminal.
 */
function markPlatform() {
	document.documentElement.dataset.platform = String(api.platform ?? '')
}

/** Rebuild the tab bar. */
function renderTabs() {
	tabsEl.replaceChildren()
	state.tabs.forEach((tab, index) => {
		const button = document.createElement('button')
		button.type = 'button'
		button.className = 'tab'
		button.setAttribute('role', 'tab')
		button.setAttribute('aria-selected', tab.id === state.activeId ? 'true' : 'false')
		button.title = index < 9 ? `${tab.label} — Alt+${String(index + 1)}` : tab.label

		const dot = document.createElement('span')
		dot.className = 'dot'
		dot.dataset.state = tab.state
		button.appendChild(dot)

		const label = document.createElement('span')
		label.className = 'tab-label'
		label.textContent = tab.label
		button.appendChild(label)

		const key = document.createElement('span')
		key.className = 'tab-key'
		key.textContent = String(index + 1)
		button.appendChild(key)

		// The controls live in their own box so the label's width is not affected by
		// how many of them a tab has. `flex-shrink: 0` on the box, `min-width: 0` on
		// the label: a long device label shortens, the controls never disappear.
		const controls = document.createElement('span')
		controls.className = 'tab-controls'

		// **Restart is a first-class action, not a debugging affordance.** The local
		// Harness is a child process of this application, so replacing it used to mean
		// closing the whole desktop and launching it again — which is how an operator
		// ends up doing the one thing that can leave the old one behind, and why
		// "restart the web process" felt like it needed the application closed. It is
		// also the only way to pick up a change to the Harness or to the profile its
		// config lives in, so it belongs on the tab that owns the process.
		//
		// Offered whenever there is something to restart *or* something to start
		// again: a failed tab is the case an operator reaches for this in, and a
		// running one is the case they came for.
		if (tab.state !== 'idle') {
			const restart = document.createElement('button')
			restart.type = 'button'
			restart.className = 'tab-restart'
			restart.textContent = '⟲'
			restart.title = tab.kind === 'local' ? 'Restart the local Harness' : 'Reconnect'
			restart.addEventListener('click', (event) => {
				event.stopPropagation()
				void api.restart(tab.id).then(apply)
			})
			controls.appendChild(restart)
		}

		// The control stops the tab rather than removing it: a device tab is one of
		// the configured things and stays in the bar, so the next click or
		// Alt+digit brings it straight back. Removing a device lives in the popover.
		//
		// The local tab has no `×` and that is deliberate, not an omission: nothing
		// recreates it, so stopping it there would leave a tab that can never come
		// back. Restart above is what the local Harness gets instead, and it is the
		// operation that is actually wanted.
		if (tab.id !== 'local' && tab.state !== 'idle') {
			const stop = document.createElement('button')
			stop.type = 'button'
			stop.className = 'tab-close'
			stop.textContent = '×'
			stop.title = 'Disconnect'
			stop.addEventListener('click', (event) => {
				event.stopPropagation()
				void api.disconnect(tab.id).then(apply)
			})
			controls.appendChild(stop)
		}

		button.appendChild(controls)

		button.addEventListener('click', () => {
			// Selection, not connection: see `select` in the main process. The panel
			// this shows offers the CONNECT itself.
			void api.select(tab.id).then(apply)
		})
		tabsEl.appendChild(button)
	})
}

/** Draw the one panel a non-running active tab needs. */
function panelFor(tab) {
	const panel = document.createElement('div')
	panel.className = 'panel'
	const heading = document.createElement('h2')
	if (tab.state === 'idle') {
		// **A tab that has never been up is not "starting".** Selecting it only shows
		// it: the connection is this button, because a tab switch is a question about
		// which tab you are looking at and not a request to start a Harness somewhere
		// else. Alt+digit and a click both land here, and neither connects.
		heading.textContent = `${tab.label} is not connected`
		panel.appendChild(heading)
		const hint = document.createElement('div')
		hint.textContent =
			tab.kind === 'local' ? 'the local Harness is not running' : 'nothing is running on that machine'
		panel.appendChild(hint)
		const connect = document.createElement('button')
		connect.type = 'button'
		connect.textContent = 'Connect'
		connect.addEventListener('click', () => {
			void api.activate(tab.id).then(apply)
		})
		panel.appendChild(connect)
		return panel
	}
	if (tab.state === 'failed') {
		heading.textContent = `${tab.label} could not start`
		panel.appendChild(heading)
		const reason = document.createElement('div')
		reason.textContent = tab.error ?? 'no reason was recorded'
		panel.appendChild(reason)
		const retry = document.createElement('button')
		retry.type = 'button'
		retry.textContent = 'Try again'
		retry.addEventListener('click', () => {
			void api.activate(tab.id).then(apply)
		})
		panel.appendChild(retry)
		void api.transcript(tab.id).then((result) => {
			if (result.lines.length === 0) return
			const pre = document.createElement('pre')
			pre.textContent = result.lines.join('\n')
			panel.appendChild(pre)
		})
		return panel
	}
	heading.textContent = `Starting ${tab.label}…`
	panel.appendChild(heading)
	const hint = document.createElement('div')
	hint.textContent = tab.kind === 'local' ? 'launching the local Harness' : 'opening the ssh tunnel'
	panel.appendChild(hint)
	return panel
}

/**
 * How many times a guest that failed to load is asked again, and how long to wait.
 *
 * **A guest is navigated once, and a refusal it receives then is what it keeps.** That
 * is the shape of the failure this exists for: the tab says `running`, the harness is
 * up, and the content area is a flat rectangle — because the document Chromium got was
 * the server's one-line refusal (or a transport error), and reloading by hand re-asks
 * the same question and gets the same answer. Nothing in the application used to
 * notice, so the only ways out were to press `⟲` or restart the whole application.
 *
 * The delays are spaced out because the interesting case is a race: the connect path
 * already waits for the URL to answer before the tab is called running, so a guest that
 * still failed is either early by a hair or talking to something that is genuinely not
 * serving. Three tries over about two seconds tells those apart without hammering a
 * server that is down.
 */
const GUEST_RETRY_DELAYS_MS = [0, 500, 1500]

/**
 * Reconcile the content area with the tab list.
 *
 * A guest is created once per (tab, url) pair and then left alone, because
 * recreating one reloads the interface inside it: the remote Harness loses its
 * scroll position and whatever was typed into it. This used to say the cost was a
 * reload "every three seconds", which was never true — nothing in `src/` polls,
 * and `main.js` publishes only when something actually changes (a tab starts,
 * stops, fails or is saved). The reason to reconcile rather than rebuild stands on
 * its own, so the number went rather than a timer being added to justify it.
 *
 * A guest that fails to load is the exception, and it is handled where it happens: the
 * reloads are a repair of the one document, so they must not go through the state that
 * decides a tab is running.
 */
function renderContent() {
	const active = state.tabs.find((tab) => tab.id === state.activeId)
	const wanted = new Set()
	for (const tab of state.tabs) {
		if (tab.state !== 'running' || tab.url === undefined) continue
		wanted.add(tab.id)
		const existing = views.get(tab.id)
		if (existing !== undefined && existing.url === tab.url) continue
		if (existing !== undefined) {
			existing.element.remove()
			views.delete(tab.id)
		}
		const view = document.createElement('webview')
		view.setAttribute('src', tab.url)
		wireGuest(view, tab.id)
		contentEl.appendChild(view)
		views.set(tab.id, { element: view, url: tab.url })
	}
	for (const [id, entry] of [...views]) {
		if (wanted.has(id)) continue
		entry.element.remove()
		views.delete(id)
	}
	for (const [id, entry] of views) {
		entry.element.hidden = id !== state.activeId
	}
	const panels = contentEl.querySelectorAll('.panel')
	for (const panel of panels) panel.remove()
	if (active !== undefined && (active.state !== 'running' || active.url === undefined)) {
		contentEl.appendChild(panelFor(active))
	}
}

/**
 * Give one guest its load-failure repair.
 *
 * `did-fail-load` carries the error for a navigation that never produced a document, and
 * `render-process-gone` covers the guest's process dying underneath a document that had
 * loaded. Both leave the same blank rectangle, so both are asked again.
 *
 * `errorCode === -3` is `ERR_ABORTED`, which is what a navigation that was replaced by a
 * newer one reports — every ordinary tab switch can produce it — so it is not a failure.
 * `isMainFrame` matters for the same reason: a failed subresource is not a blank tab.
 *
 * @param view - the guest element.
 * @param id - the tab it belongs to.
 */
function wireGuest(view, id) {
	let attempt = 0
	view.addEventListener('did-fail-load', (event) => {
		if (event.errorCode === -3 || event.isMainFrame === false) return
		if (views.get(id)?.element !== view) return
		if (attempt >= GUEST_RETRY_DELAYS_MS.length) {
			// Out of tries: drop the entry so the next push rebuilds the element from
			// scratch. A new element is a new navigation, which is the one thing left
			// to try — and it is what pressing the tab's own restart does, without
			// replacing a Harness that is already up.
			view.remove()
			views.delete(id)
			return
		}
		const delay = GUEST_RETRY_DELAYS_MS[attempt]
		attempt += 1
		setTimeout(() => {
			// Reloading a replaced element would navigate a guest nobody is looking at.
			if (views.get(id)?.element !== view) return
			try {
				view.reload()
			} catch {
				/* the element went away between the check and the reload */
			}
		}, delay)
	})
	view.addEventListener('render-process-gone', () => {
		if (views.get(id)?.element !== view) return
		try {
			view.reload()
		} catch {
			/* nothing left to reload */
		}
	})
}

/**
 * Render one complete state push.
 *
 * `tabs` and `activeId` are the state the main process pushes on its own; anything
 * else it sent alongside them — the device list's `problems`, which is the only way
 * a record the book had to drop is ever mentioned — is carried through rather than
 * dropped, because the next `tabs:state` push would otherwise erase it before the
 * popover had drawn.
 *
 * @param next - the state from the main process.
 */
function apply(next) {
	if (next !== undefined && next !== null) state = { ...state, ...next }
	renderTabs()
	renderContent()
}

/** Build the device popover. */
function renderPopover() {
	popoverEl.replaceChildren()
	// Any record the book could not hold is reported before anything else, because it
	// is the one thing here the operator cannot see for themselves: the device is
	// simply absent from the list below, and the reason is in a JSON file they may
	// never have opened. `problems` is what `devices:list` kept from the last load.
	for (const problem of state.problems ?? []) {
		const complaint = document.createElement('div')
		complaint.className = 'hint'
		complaint.textContent = problem
		popoverEl.appendChild(complaint)
	}
	// "Open" has to mean *running*, not *present in the bar*: every device in the
	// book has a tab by design, so a set of tab ids would mark all of them and say
	// nothing. The state is what tells the operator whether clicking will connect
	// or merely focus something already up.
	const states = new Map(state.tabs.map((tab) => [tab.id, tab.state]))
	const suffixFor = (id) => {
		const tabState = states.get(id)
		if (tabState === 'running') return ' — open'
		if (tabState === 'starting') return ' — starting'
		if (tabState === 'failed') return ' — failed'
		return ''
	}

	for (const device of devices) {
		const row = document.createElement('div')
		row.className = 'row'

		const main = document.createElement('div')
		main.className = 'row-main'
		const label = document.createElement('div')
		label.className = 'row-label'
		label.textContent = `${device.label}${suffixFor(device.id)}`
		const sub = document.createElement('div')
		sub.className = 'row-sub'
		sub.textContent = `${device.user}@${device.host}:${String(device.sshPort)}${device.platform === undefined ? '' : ` · ${device.platform}`}`
		main.append(label, sub)
		main.addEventListener('click', () => {
			popoverEl.hidden = true
			void api.open(device.id).then(apply)
		})
		row.appendChild(main)

		const remove = document.createElement('button')
		remove.type = 'button'
		remove.textContent = 'Remove'
		remove.addEventListener('click', () => {
			void api.remove(device.id).then(() => refreshDevices())
		})
		row.appendChild(remove)
		popoverEl.appendChild(row)
	}

	if (devices.length === 0) {
		const hint = document.createElement('div')
		hint.className = 'hint'
		hint.textContent = 'No devices yet. Add one below.'
		popoverEl.appendChild(hint)
	}

	const form = document.createElement('form')
	const fields = [
		{ name: 'label', placeholder: 'label, e.g. box-b' },
		{ name: 'host', placeholder: 'host or address', required: true },
		{ name: 'user', placeholder: 'ssh user', required: true },
		{ name: 'sshPort', placeholder: 'ssh port (22)' },
		{ name: 'directory', placeholder: 'launch directory (optional)' }
	]
	const inputs = {}
	for (const field of fields) {
		const input = document.createElement('input')
		input.name = field.name
		input.placeholder = field.placeholder
		if (field.required === true) input.required = true
		inputs[field.name] = input
		form.appendChild(input)
	}
	const submit = document.createElement('button')
	submit.type = 'submit'
	submit.textContent = 'Add device'
	form.appendChild(submit)
	form.addEventListener('submit', (event) => {
		event.preventDefault()
		void api
			.save({
				label: inputs.label.value.trim() || inputs.host.value.trim(),
				host: inputs.host.value.trim(),
				user: inputs.user.value.trim(),
				sshPort: inputs.sshPort.value.trim(),
				directory: inputs.directory.value.trim()
			})
			.then(() => {
				for (const input of Object.values(inputs)) input.value = ''
				return refreshDevices()
			})
			.catch((error) => {
				const hint = document.createElement('div')
				hint.className = 'hint'
				hint.textContent = String(error?.message ?? error)
				popoverEl.appendChild(hint)
			})
	})
	popoverEl.appendChild(form)

	// **The update check is reachable, not automatic-only.** A sideloaded desktop
	// build has no store to push a version; the launch check is the convenience, and
	// this is the control that works when it said nothing or failed. The main process
	// owns the whole flow — checking, downloading and restarting — so this button
	// only asks.
	const updates = document.createElement('div')
	updates.className = 'update'
	const updatesHint = document.createElement('div')
	updatesHint.className = 'hint'
	updatesHint.textContent = 'Updates come from GitHub Releases'
	const updateButton = document.createElement('button')
	updateButton.type = 'button'
	updateButton.textContent = 'Check for updates'
	updateButton.addEventListener('click', () => {
		void api.checkUpdates()
	})
	updates.append(updatesHint, updateButton)
	popoverEl.appendChild(updates)
}

/** Reload the device list and redraw the popover. */
async function refreshDevices() {
	const result = await api.devices()
	devices = result.devices
	// The problems travel *with* the tabs rather than beside them, because `apply`
	// merges into the state the panel reads: a version that dropped them here meant
	// the panel drew with none, which is exactly what a clean book looks like.
	apply({ ...result.tabs, problems: result.problems })
	renderPopover()
}

addEl.addEventListener('click', () => {
	const opening = popoverEl.hidden
	popoverEl.hidden = !opening
	if (opening) void refreshDevices()
})

document.addEventListener('click', (event) => {
	if (popoverEl.hidden) return
	if (popoverEl.contains(event.target) || event.target === addEl) return
	popoverEl.hidden = true
})

// The main process decides which tab a shortcut selects; this only follows.
api.onShortcut((id) => {
	state = { ...state, activeId: id }
	renderTabs()
	renderContent()
})

api.onState((next) => {
	apply(next)
})

markPlatform()


void refreshDevices()
