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

		// The control stops the tab rather than removing it: a device tab is one of
		// the configured things and stays in the bar, so the next click or
		// Alt+digit brings it straight back. Removing a device lives in the popover.
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
			button.appendChild(stop)
		}

		button.addEventListener('click', () => {
			void api.activate(tab.id).then(apply)
		})
		tabsEl.appendChild(button)
	})
}

/** Draw the one panel a non-running active tab needs. */
function panelFor(tab) {
	const panel = document.createElement('div')
	panel.className = 'panel'
	const heading = document.createElement('h2')
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
 * Reconcile the content area with the tab list.
 *
 * A guest is created once per (tab, url) pair and then left alone, because
 * recreating one reloads the interface inside it: the remote Harness loses its
 * scroll position and whatever was typed into it. This used to say the cost was a
 * reload "every three seconds", which was never true — nothing in `src/` polls,
 * and `main.js` publishes only when something actually changes (a tab starts,
 * stops, fails or is saved). The reason to reconcile rather than rebuild stands on
 * its own, so the number went rather than a timer being added to justify it.
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
