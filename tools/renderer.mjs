/**
 * Drive the real renderer against a DOM.
 *
 * `tools/smoke.mjs` reads the renderer's source and asserts things about the
 * text. That catches drift and nothing else: it cannot tell whether the tab bar
 * actually renders, whether a guest is reused across state pushes, or whether the
 * failure panel appears at all. The renderer is the layer that is hardest to
 * verify and the one written most blind, so it gets a DOM.
 *
 * jsdom is not Chromium and this does not prove the window looks right. It does
 * prove the reconciliation logic — one guest per (tab, url), correct hiding,
 * correct panels, correct IPC calls — which is where the bugs would be.
 *
 * Usage: node tools/renderer.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const require = createRequire(import.meta.url)

const html = readFileSync(join(ROOT, 'src', 'renderer', 'index.html'), 'utf8')
const rendererSource = readFileSync(join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')

let passes = 0
const failures = []

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
 * Build a fresh renderer harness with its own DOM and a scriptable main process.
 * @param options - the initial tab state and device list.
 * @returns the harness.
 */
function harness(options = {}) {
	// The script tag is removed so jsdom never tries to fetch it: this harness
	// evaluates the real source itself, in the window's own realm.
	const dom = new JSDOM(html.replace(/<script src="app\.js"><\/script>/u, ''), {
		runScripts: 'outside-only',
		url: 'file:///app/index.html',
		pretendToBeVisual: true
	})
	const { window } = dom

	const calls = []
	const terminals = []
	const transcripts = options.transcripts ?? {}
	/**
	 * What the main process says this machine can open.
	 *
	 * Three available presets by default, because that is what a development machine
	 * with both agents installed answers; a test about an unavailable one passes its
	 * own list.
	 */
	const presets = options.presets ?? [
		{ id: 'shell', label: 'Shell', available: true },
		{ id: 'pi', label: 'pi', available: true },
		{ id: 'opencode', label: 'opencode', available: true }
	]
	let state = options.state ?? { activeId: 'local', tabs: [] }
	let devices = options.devices ?? []
	let problems = options.problems ?? []
	let onState = () => {}
	let onShortcut = () => {}
	let onTerminalData = () => {}
	let failSave
	/**
	 * The password request the next call should answer with, if any.
	 *
	 * The real main process answers a request it cannot satisfy with `needsPassword`
	 * beside the state and starts nothing. The fake does the same, once, and only when
	 * no password was supplied — which is exactly the shape `answerPasswordRequests`
	 * has to handle.
	 */
	let nextPasswordPrompt

	/**
	 * Answer a request with the armed password prompt, once.
	 * @param base - the state the fake would otherwise return.
	 * @param password - what the page sent; a prompt is only owed on the first ask.
	 * @returns the state, with the request beside it when one is armed.
	 */
	function takePrompt(base, password) {
		if (password !== undefined || nextPasswordPrompt === undefined) return base
		const prompt = nextPasswordPrompt
		nextPasswordPrompt = undefined
		return { ...base, needsPassword: prompt }
	}

	/**
	 * A terminal emulator with the surface `app.js` uses.
	 *
	 * jsdom has no canvas and no xterm, and the point of this harness is the
	 * reconciliation logic, not the renderer inside a terminal. Every handle the tab
	 * code touches — `open`, `reset`, `focus`, `dispose`, `write`, `onData` — is a
	 * counter, so the tests can ask what happened instead of looking at pixels.
	 */
	class FakeTerminal {
		constructor(terminalOptions) {
			this.options = terminalOptions
			this.cols = 80
			this.rows = 24
			this.writes = []
			this.resets = 0
			this.focuses = 0
			this.disposed = 0
			this.dataListeners = []
			this.element = window.document.createElement('div')
			this.element.className = 'xterm'
			terminals.push(this)
		}
		loadAddon(addon) {
			this.addon = addon
			addon.activate?.(this)
		}
		open(host) {
			host.appendChild(this.element)
		}
		onData(listener) {
			this.dataListeners.push(listener)
			return { dispose() {} }
		}
		attachCustomKeyEventHandler(handler) {
			this.keyHandler = handler
		}
		hasSelection() {
			return this.selected !== undefined
		}
		getSelection() {
			return this.selected ?? ''
		}
		clearSelection() {
			this.selected = undefined
		}
		write(data) {
			this.writes.push(data)
		}
		reset() {
			this.resets += 1
		}
		focus() {
			this.focuses += 1
		}
		dispose() {
			this.disposed += 1
		}
		/** Test-only: type into the terminal, as xterm's textarea would. */
		type(data) {
			for (const listener of this.dataListeners) listener(data)
		}
	}
	class FakeFitAddon {
		activate(term) {
			this.term = term
		}
		fit() {
			this.fits = (this.fits ?? 0) + 1
			// A measurement that differs from the constructor's 80x24, so the resize
			// path has something to report.
			this.term.cols = 120
			this.term.rows = 30
		}
	}
	window.Terminal = FakeTerminal
	window.FitAddon = { FitAddon: FakeFitAddon }

	window.dshTabs = {
		state: async () => state,
		activate: async (id, password) => {
			calls.push(password === undefined ? ['activate', id] : ['activate', id, password])
			return takePrompt(state, password)
		},
		select: async (id) => {
			calls.push(['select', id])
			return state
		},
		disconnect: async (id) => {
			calls.push(['disconnect', id])
			return state
		},
		restart: async (id, password) => {
			calls.push(password === undefined ? ['restart', id] : ['restart', id, password])
			return takePrompt(state, password)
		},
		reap: async (id) => {
			calls.push(['reap', id])
			return state
		},
		devices: async () => {
			calls.push(['devices'])
			return { devices, tabs: state, problems }
		},
		open: async (id) => {
			calls.push(['open', id])
			return state
		},
		save: async (device) => {
			calls.push(['save', device])
			if (failSave !== undefined) throw new Error(failSave)
			return { devices }
		},
		remove: async (id) => {
			calls.push(['remove', id])
			return { devices }
		},
		transcript: async (id) => ({ lines: transcripts[id] ?? [] }),
		checkUpdates: async () => {
			calls.push(['checkUpdates'])
			return { version: 'test' }
		},
		terminalOpen: async (id, password) => {
			calls.push(password === undefined ? ['terminalOpen', id] : ['terminalOpen', id, password])
			return takePrompt(state, password)
		},
		terminalPresets: async () => {
			calls.push(['terminalPresets'])
			return { presets }
		},
		terminalOpenLocal: async (preset) => {
			calls.push(['terminalOpenLocal', preset])
			return state
		},
		terminalAttach: async (id) => {
			calls.push(['terminalAttach', id])
		},
		terminalInput: (id, data) => {
			calls.push(['terminalInput', id, data])
		},
		terminalResize: (id, cols, rows) => {
			calls.push(['terminalResize', id, cols, rows])
		},
		clipboard: {
			read: async () => '',
			write: async (text) => {
				calls.push(['clipboardWrite', text])
			}
		},
		onState: (listener) => {
			onState = listener
			return () => {}
		},
		onTerminalData: (listener) => {
			onTerminalData = listener
			return () => {}
		},
		onShortcut: (listener) => {
			onShortcut = listener
			return () => {}
		}
	}

	window.eval(rendererSource)

	return {
		window,
		document: window.document,
		calls,
		/** Let every already-scheduled promise settle. */
		async flush() {
			await new Promise((resolve) => {
				setTimeout(resolve, 0)
			})
		},
		setState(next) {
			state = next
		},
		pushState(next) {
			state = next
			onState(next)
		},
		pushShortcut(id) {
			onShortcut(id)
		},
		setDevices(next) {
			devices = next
		},
		setProblems(next) {
			problems = next
		},
		failNextSave(message) {
			failSave = message
		},
		/** Answer the next request with a password prompt, once. */
		askPasswordNext(prompt) {
			nextPasswordPrompt = prompt
		},
		tabs: () => [...window.document.querySelectorAll('.tab')],
		guests: () => [...window.document.querySelectorAll('webview')],
		terminals,
		terminalHosts: () => [...window.document.querySelectorAll('.terminal-host')],
		pushTerminalData(payload) {
			onTerminalData(payload)
		},
		panels: () => [...window.document.querySelectorAll('.panel')],
		popover: () => window.document.getElementById('popover')
	}
}

/** The state three tabs produce: local, one running device, one idle device. */
function threeTabs() {
	return {
		activeId: 'local',
		tabs: [
			{ id: 'local', kind: 'local', label: 'Local', state: 'running', url: 'http://127.0.0.1:1000/', partition: 'dsh-tabs-guest-local', persistent: true },
			{ id: 'dev-a', kind: 'remote', label: 'box-a', state: 'running', url: 'http://127.0.0.1:1001/?token=a', partition: 'dsh-tabs-guest-dev-a' },
			{ id: 'dev-b', kind: 'remote', label: 'box-b', state: 'idle' }
		]
	}
}

console.log('the tab bar')

await test('every tab renders, numbered, with the active one marked', async () => {
	const h = harness({ state: threeTabs(), devices: [] })
	await h.flush()
	const tabs = h.tabs()
	assert.equal(tabs.length, 3)
	assert.deepEqual(tabs.map((tab) => tab.querySelector('.tab-label').textContent), ['Local', 'box-a', 'box-b'])
	assert.deepEqual(tabs.map((tab) => tab.querySelector('.tab-key').textContent), ['1', '2', '3'])
	assert.deepEqual(tabs.map((tab) => tab.getAttribute('aria-selected')), ['true', 'false', 'false'])
	assert.deepEqual(tabs.map((tab) => tab.querySelector('.dot').dataset.state), ['running', 'running', 'idle'])
})

await test('a state push redraws the bar without losing the active tab', async () => {
	const h = harness({ state: threeTabs(), devices: [] })
	await h.flush()
	h.pushState({ ...threeTabs(), activeId: 'dev-b', tabs: threeTabs().tabs.map((tab) => (tab.id === 'dev-b' ? { ...tab, state: 'starting' } : tab)) })
	const tabs = h.tabs()
	assert.equal(tabs.length, 3)
	assert.equal(tabs[2].getAttribute('aria-selected'), 'true')
	assert.equal(tabs[2].querySelector('.dot').dataset.state, 'starting')
})

console.log('guests')

await test('a running tab creates exactly one guest', async () => {
	const h = harness({ state: threeTabs(), devices: [] })
	await h.flush()
	// Only the active tab's guest is drawn? No — every running tab gets one, and
	// the inactive ones are hidden, so switching is instant and does not reload.
	assert.equal(h.guests().length, 2)
	assert.deepEqual(h.guests().map((guest) => guest.getAttribute('src')), ['http://127.0.0.1:1000/', 'http://127.0.0.1:1001/?token=a'])
})

await test('a guest runs in its tab\u2019s own session', async () => {
	// **The partition is what stops one Harness's auth cookie from accumulating beside
	// another's.** The main process names the session and empties it per connect; the
	// renderer's half is that the element must be created in that session before it
	// navigates. A guest without the attribute falls back to the window's persistent
	// jar, which is the state that produced 70 cookies and a blank page.
	const h = harness({ state: threeTabs(), devices: [] })
	await h.flush()
	assert.deepEqual(
		h.guests().map((guest) => guest.getAttribute('partition')),
		['dsh-tabs-guest-local', 'dsh-tabs-guest-dev-a']
	)
	for (const guest of h.guests()) {
		assert.equal(String(guest.getAttribute('partition')).startsWith('persist:'), false, 'a guest session would persist')
	}
})

await test('a repeated state push reuses the same guest element', async () => {
	// This is the invariant that matters: a guest rebuilt on every push would
	// reload every remote interface, which is the reload loop this project already
	// paid for once in the plugin.
	const h = harness({ state: threeTabs(), devices: [] })
	await h.flush()
	const first = h.guests()[1]
	h.pushState(threeTabs())
	h.pushState(threeTabs())
	const again = h.guests()[1]
	assert.equal(h.guests().length, 2)
	assert.equal(first, again, 'the guest element was replaced')
})

await test('a changed url replaces the guest', async () => {
	const h = harness({ state: threeTabs(), devices: [] })
	await h.flush()
	const first = h.guests()[1]
	const next = threeTabs()
	next.tabs[1].url = 'http://127.0.0.1:2002/?token=b'
	h.pushState(next)
	const replaced = h.guests()[1]
	assert.notEqual(first, replaced)
	assert.equal(replaced.getAttribute('src'), 'http://127.0.0.1:2002/?token=b')
})

console.log('a guest that cannot load')

/**
 * Give a guest element the reload counter the repair needs.
 *
 * jsdom has no `webview`, so the reload is counted here rather than observed: the
 * assertion is about *how many times* the application asks again, which is the whole
 * behaviour. The events come from the window's own realm — a `new Event(...)` in this
 * file is Node's, and jsdom refuses it as not an `Event`.
 *
 * @param window - the page's window, for its `Event` constructor.
 * @param guest - the element the renderer created.
 * @returns the handles.
 */
function watchGuest(window, guest) {
	let reloads = 0
	guest.reload = () => {
		reloads += 1
	}
	return {
		reloads: () => reloads,
		fail(errorCode = -105, isMainFrame = true) {
			const event = new window.Event('did-fail-load')
			event.errorCode = errorCode
			event.isMainFrame = isMainFrame
			guest.dispatchEvent(event)
		},
		gone() {
			guest.dispatchEvent(new window.Event('render-process-gone'))
		}
	}
}

await test('a failed load is retried, and a subresource failure is not', async () => {
	// **The blank tab.** A guest navigated to something that is not the Web UI — a
	// refusal, a transport error — leaves a flat rectangle, and nothing in the
	// application used to notice: the tab said running and reloading by hand re-asked
	// the same question. Now the failure is repaired, and the two filters that keep the
	// repair off healthy tabs are checked here by name:
	//
	// * `ERR_ABORTED` (-3) is what a navigation replaced by a newer one reports, which
	//   every ordinary tab switch can produce;
	// * a failed *subresource* is not a blank tab.
	const h = harness({ state: threeTabs(), devices: [] })
	await h.flush()
	const guest = h.guests()[1]
	const watch = watchGuest(h.window, guest)

	watch.fail(-3)
	watch.fail(-105, false)
	await h.flush()
	assert.equal(watch.reloads(), 0, 'a healthy tab was reloaded')

	// A real failure is retried, on the schedule the renderer declares.
	watch.fail()
	await new Promise((resolve) => {
		setTimeout(resolve, 30)
	})
	assert.equal(watch.reloads(), 1, 'the first retry did not happen')
	watch.fail()
	await new Promise((resolve) => {
		setTimeout(resolve, 700)
	})
	assert.equal(watch.reloads(), 2, 'the second retry did not happen after its delay')

	// And a guest whose process died is asked again too: the document is gone either way.
	watch.gone()
	assert.equal(watch.reloads(), 3, 'a dead guest process was left alone')
})

await test('after the retries run out the element is rebuilt, not reloaded for ever', async () => {
	// The end of the schedule has to *change* something: an element that keeps failing
	// and keeps reloading is a tab that flickers and never recovers. Dropping the entry
	// is what makes the next state push build a new element — a new navigation, and the
	// same thing pressing the tab's own restart does without replacing a live Harness.
	const h = harness({ state: threeTabs(), devices: [] })
	await h.flush()
	const guest = h.guests()[1]
	const watch = watchGuest(h.window, guest)

	for (let round = 1; round <= 3; round += 1) {
		watch.fail()
		await new Promise((resolve) => {
			setTimeout(resolve, 30 + round * 600)
		})
	}
	assert.equal(watch.reloads(), 3, `expected three retries, saw ${String(watch.reloads())}`)

	// The entry is gone, so the same state push rebuilds instead of reusing.
	watch.fail()
	h.pushState(threeTabs())
	const rebuilt = h.guests()[1]
	assert.notEqual(rebuilt, guest, 'the failing element was reused instead of rebuilt')
	assert.equal(h.guests().length, 2, 'rebuilding changed how many guests there are')
})

await test('a tab that stops running loses its guest', async () => {
	const h = harness({ state: threeTabs(), devices: [] })
	await h.flush()
	const next = threeTabs()
	next.tabs[1] = { id: 'dev-a', kind: 'remote', label: 'box-a', state: 'idle' }
	h.pushState(next)
	assert.equal(h.guests().length, 1)
	assert.equal(h.guests()[0].getAttribute('src'), 'http://127.0.0.1:1000/')
})

await test('a detached persistent tab keeps its guest, and offers both ways out', async () => {
	// The page is the Session view the operator left: destroying it would throw away
	// the scroll position and the half-typed message to redraw the same URL. So the
	// element survives a detached state, and the banner is what carries the controls.
	const state = threeTabs()
	state.activeId = 'dev-a'
	state.tabs[1] = { ...state.tabs[1], state: 'detached', persistent: true, adopted: true }
	const h = harness({ state, devices: [] })
	await h.flush()
	assert.equal(h.guests().length, 2, 'the detached guest was destroyed')
	assert.equal(h.panels().length, 0, 'a full panel covered the page being kept')
	const banner = h.document.querySelector('.detached-banner')
	assert.ok(banner !== null, 'a detached persistent tab shows no banner')
	assert.match(banner.textContent, /reconnecting/u)
	const buttons = [...banner.querySelectorAll('button')]
	assert.deepEqual(buttons.map((button) => button.textContent), ['Reconnect now', 'Stop host'])
	buttons[1].dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	assert.deepEqual(h.calls.filter(([name]) => name === 'reap'), [['reap', 'dev-a']])
})

await test('a running persistent tab offers Stop host, and its × says it keeps the host', async () => {
	const state = threeTabs()
	state.tabs[1] = { ...state.tabs[1], persistent: true, adopted: false }
	const h = harness({ state, devices: [] })
	await h.flush()
	const tab = h.tabs()[1]
	const reap = tab.querySelector('.tab-reap')
	assert.ok(reap !== null, 'a persistent tab has no Stop host control')
	reap.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	assert.deepEqual(h.calls.filter(([name]) => name === 'reap'), [['reap', 'dev-a']])
	// The ordinary × must not promise a kill it does not perform.
	assert.match(tab.querySelector('.tab-close').title, /keeps running/u)
})

await test('only the active guest is visible', async () => {
	const h = harness({ state: threeTabs(), devices: [] })
	await h.flush()
	assert.deepEqual(h.guests().map((guest) => guest.hidden), [false, true])
	h.pushState({ ...threeTabs(), activeId: 'dev-a' })
	assert.deepEqual(h.guests().map((guest) => guest.hidden), [true, false])
})

console.log('panels')

await test('a starting tab says so, and names what it is waiting for', async () => {
	const h = harness({
		state: { activeId: 'dev-a', tabs: [{ id: 'dev-a', kind: 'remote', label: 'box-a', state: 'starting' }] },
		devices: []
	})
	await h.flush()
	const panel = h.panels()
	assert.equal(panel.length, 1)
	assert.match(panel[0].textContent, /Starting box-a/u)
	assert.match(panel[0].textContent, /ssh tunnel/u)
})

await test('an idle tab is offered a CONNECT and does not start itself', async () => {
	const h = harness({
		state: { activeId: 'dev-a', tabs: [{ id: 'dev-a', kind: 'remote', label: 'box-a', state: 'idle' }] },
		devices: []
	})
	await h.flush()
	const panel = h.panels()
	assert.equal(panel.length, 1)
	assert.match(panel[0].textContent, /box-a is not connected/u)
	assert.deepEqual(h.calls.filter(([name]) => name === 'activate'), [], 'showing a tab connected it')
	const connect = [...panel[0].querySelectorAll('button')].find((button) => button.textContent === 'Connect')
	assert.ok(connect !== undefined, 'the idle panel has no Connect button')
	connect.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	assert.deepEqual(h.calls.filter(([name]) => name === 'activate'), [['activate', 'dev-a']])
})

await test('a failed tab names the reason and shows the transcript', async () => {
	const h = harness({
		state: { activeId: 'dev-a', tabs: [{ id: 'dev-a', kind: 'remote', label: 'box-a', state: 'failed', error: 'the ssh tunnel never began accepting connections' }] },
		devices: [],
		transcripts: { 'dev-a': ['connect deploy@10.0.0.2:22', 'FAILED: the ssh tunnel never began accepting connections'] }
	})
	await h.flush()
	await h.flush()
	const text = h.panels()[0].textContent
	assert.match(text, /box-a could not start/u)
	assert.match(text, /the ssh tunnel never began accepting connections/u)
	assert.match(text, /FAILED: the ssh tunnel/u)
})

console.log('password prompts')

/** An idle password device's tab, which is what a password request arrives on. */
function idlePasswordTab() {
	return { activeId: 'dev-p', tabs: [{ id: 'dev-p', kind: 'remote', label: 'box-p', state: 'idle' }] }
}

/**
 * Click the Connect button in the panel that is showing.
 * @param h - the harness.
 */
function pressConnect(h) {
	const panel = h.panels()[0]
	const connect = [...panel.querySelectorAll('button')].find((button) => button.textContent === 'Connect')
	assert.ok(connect !== undefined, 'the idle panel has no Connect button')
	connect.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
}

await test('a request for a password opens a dialog, and the answer goes back to the main process', async () => {
	const h = harness({ state: idlePasswordTab(), devices: [] })
	await h.flush()
	h.askPasswordNext({ id: 'dev-p', label: 'box-p', user: 'deploy', host: '10.0.0.2' })
	pressConnect(h)
	await h.flush()
	const dialog = h.document.querySelector('.password-dialog')
	assert.ok(dialog !== null, 'no dialog appeared for a password request')
	assert.match(dialog.textContent, /deploy@10\.0\.0\.2/u)
	assert.match(dialog.textContent, /this run only/u)
	const input = dialog.querySelector('input')
	assert.equal(input.type, 'password')
	assert.equal(input.name, 'password')
	input.value = 'secret'
	dialog.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }))
	await h.flush()
	assert.equal(h.document.querySelector('.password-dialog'), null, 'the dialog stayed open')
	assert.deepEqual(
		h.calls.filter(([name]) => name === 'activate'),
		[
			['activate', 'dev-p'],
			['activate', 'dev-p', 'secret']
		]
	)
	// The password is not kept in the page: a state push redraws from the main
	// process, and nothing here may echo the secret back into the document.
	assert.equal(h.document.body.textContent.includes('secret'), false, 'the password was drawn on the page')
})

await test('cancelling the password dialog connects nothing', async () => {
	const h = harness({ state: idlePasswordTab(), devices: [] })
	await h.flush()
	h.askPasswordNext({ id: 'dev-p', label: 'box-p', user: 'deploy', host: '10.0.0.2' })
	pressConnect(h)
	await h.flush()
	const dialog = h.document.querySelector('.password-dialog')
	const cancel = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')
	cancel.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	assert.equal(h.document.querySelector('.password-dialog'), null, 'the dialog stayed open')
	assert.deepEqual(h.calls.filter(([name]) => name === 'activate'), [['activate', 'dev-p']])
})

await test('a refused password reopens the dialog saying what the far side said', async () => {
	const h = harness({ state: idlePasswordTab(), devices: [] })
	await h.flush()
	h.askPasswordNext({ id: 'dev-p', label: 'box-p', user: 'deploy', host: '10.0.0.2', error: 'Permission denied (password).' })
	pressConnect(h)
	await h.flush()
	const dialog = h.document.querySelector('.password-dialog')
	assert.match(dialog.textContent, /refused/u)
	assert.match(dialog.textContent, /Permission denied/u)
})

await test('the add-device form offers the password choice and saves it', async () => {
	const h = harness({ state: { activeId: 'local', tabs: [] }, devices: [] })
	await h.flush()
	h.document.getElementById('add').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	const form = h.popover().querySelector('form')
	const select = form.querySelector('select[name="auth"]')
	assert.ok(select !== null, 'the form has no authentication choice')
	assert.deepEqual([...select.options].map((option) => option.value), ['key', 'password'])
	form.querySelector('input[name="host"]').value = 'build-01.example.net'
	form.querySelector('input[name="user"]').value = 'deploy'
	select.value = 'password'
	form.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }))
	await h.flush()
	const save = h.calls.find(([name]) => name === 'save')
	assert.equal(save[1].auth, 'password')
	// The form goes back to the default the next device would want, not to the choice
	// the last one made.
	assert.equal(select.value, 'key')
})

console.log('interaction')

await test('clicking a tab selects it and connects nothing', async () => {
	const h = harness({ state: threeTabs(), devices: [] })
	await h.flush()
	h.tabs()[1].dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	assert.deepEqual(h.calls.filter(([name]) => name === 'select'), [['select', 'dev-a']])
	assert.deepEqual(h.calls.filter(([name]) => name === 'activate'), [], 'a tab click must not start a connect')
})

await test('the disconnect control appears only when there is something to stop', async () => {
	const h = harness({ state: threeTabs(), devices: [] })
	await h.flush()
	const tabs = h.tabs()
	// Every running tab can be let go of, including the local one: its host
	// survives the disconnect. An idle device has nothing to stop.
	assert.equal(tabs[0].querySelector('.tab-close')?.title, 'Disconnect (the host keeps running)')
	assert.equal(tabs[1].querySelector('.tab-close')?.title, 'Disconnect')
	assert.equal(tabs[2].querySelector('.tab-close'), null)
	tabs[1].querySelector('.tab-close').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	assert.deepEqual(h.calls.filter(([name]) => name === 'disconnect'), [['disconnect', 'dev-a']])
})

await test('the local tab can disconnect a host that outlives the window', async () => {
	// The local Harness is a recorded host now, so `×` means "let go" and the
	// next Connect adopts the same process. Restart still asks for a *new* one,
	// which is why both controls belong on this tab.
	const h = harness({ state: threeTabs(), devices: [] })
	await h.flush()
	const local = h.tabs()[0]
	const close = local.querySelector('.tab-close')
	assert.ok(close !== null, 'the local tab cannot let go of its host')
	assert.match(close.title, /keeps running/u)
	close.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	assert.deepEqual(h.calls.filter(([name]) => name === 'disconnect'), [['disconnect', 'local']])
	// The state push redrew the bar, so the restart control is read from the new row.
	const restart = h.tabs()[0].querySelector('.tab-restart')
	assert.ok(restart !== null, 'the local tab has no restart control')
	assert.equal(restart.title, 'Restart the local Harness')
	restart.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	assert.deepEqual(h.calls.filter(([name]) => name === 'restart'), [['restart', 'local']])
	// A click on the control must not also select the tab: the button is inside the
	// tab's own click target, and a restart that switched tabs would be a surprise.
	assert.deepEqual(h.calls.filter(([name]) => name === 'activate'), [])
})

await test('restart is offered wherever there is something to restart or start again', async () => {
	// A failed tab is the case an operator reaches for this in, and an idle one has
	// nothing to replace — so the control follows the same rule the transcript does.
	const h = harness({
		state: {
			activeId: 'local',
			tabs: [
				{ id: 'local', kind: 'local', label: 'Local', state: 'running', url: 'http://127.0.0.1:1000/' },
				{ id: 'dev-a', kind: 'remote', label: 'box-a', state: 'failed', error: 'nope' },
				{ id: 'dev-b', kind: 'remote', label: 'box-b', state: 'idle' }
			]
		},
		devices: []
	})
	await h.flush()
	const tabs = h.tabs()
	assert.ok(tabs[0].querySelector('.tab-restart') !== null, 'a running tab has no restart')
	assert.ok(tabs[1].querySelector('.tab-restart') !== null, 'a failed tab has no restart')
	assert.equal(tabs[2].querySelector('.tab-restart'), null, 'an idle tab offers a restart of nothing')
	assert.equal(tabs[1].querySelector('.tab-restart').title, 'Reconnect')
})

await test('a shortcut moves the selection without asking to connect', async () => {
	// The main process already selected the tab before it sent this; asking again
	// would be a second request for something it has already done.
	const h = harness({ state: threeTabs(), devices: [] })
	await h.flush()
	h.pushShortcut('dev-a')
	await h.flush()
	assert.deepEqual(h.tabs().map((tab) => tab.getAttribute('aria-selected')), ['false', 'true', 'false'])
	assert.deepEqual(h.calls.filter(([name]) => name === 'activate'), [])
	assert.deepEqual(h.guests().map((guest) => guest.hidden), [true, false])
})

console.log('the popover')

await test('the popover lists the devices and marks the running ones', async () => {
	// "Open" must mean running, not merely present: every device in the book has a
	// tab by design, so a set of tab ids marks all of them and says nothing. This
	// check caught exactly that.
	const h = harness({
		state: threeTabs(),
		devices: [
			{ id: 'dev-a', label: 'box-a', user: 'deploy', host: '10.0.0.2', sshPort: 22, platform: 'posix' },
			{ id: 'dev-b', label: 'box-b', user: 'builder', host: '10.0.0.3', sshPort: 22 },
			{ id: 'dev-c', label: 'broken', user: 'u', host: 'h', sshPort: 22 }
		]
	})
	h.setState({ activeId: 'local', tabs: [...threeTabs().tabs, { id: 'dev-c', kind: 'remote', label: 'broken', state: 'failed' }] })
	await h.flush()
	h.document.getElementById('add').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	await h.flush()
	const rows = [...h.popover().querySelectorAll('.row')]
	assert.equal(rows.length, 3)
	assert.match(rows[0].textContent, /box-a — open/u)
	assert.match(rows[0].textContent, /deploy@10\.0\.0\.2:22 · posix/u)
	assert.match(rows[1].textContent, /box-b(?! — )/u)
	assert.doesNotMatch(rows[1].textContent, /—/u)
	assert.match(rows[2].textContent, /broken — failed/u)
})

await test('picking a device asks the main process to open it', async () => {
	const h = harness({ state: { activeId: 'local', tabs: [] }, devices: [{ id: 'dev-a', label: 'box-a', user: 'u', host: 'h', sshPort: 22 }] })
	await h.flush()
	h.document.getElementById('add').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	await h.flush()
	h.popover().querySelector('.row-main').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	assert.deepEqual(h.calls.filter(([name]) => name === 'open'), [['open', 'dev-a']])
})

await test('the popover offers an update check that asks the main process', async () => {
	const h = harness({ state: { activeId: 'local', tabs: [] }, devices: [] })
	await h.flush()
	h.document.getElementById('add').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	await h.flush()
	const button = [...h.popover().querySelectorAll('button')].find((entry) => entry.textContent === 'Check for updates')
	assert.ok(button !== undefined, 'the popover has no update control')
	button.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	assert.deepEqual(h.calls.filter(([name]) => name === 'checkUpdates'), [['checkUpdates']])
})

await test('the popover offers this machine\u2019s programs and asks for the one clicked', async () => {
	const h = harness({ state: { activeId: 'local', tabs: [] }, devices: [] })
	await h.flush()
	h.document.getElementById('add').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	await h.flush()
	const buttons = [...h.popover().querySelectorAll('.local-buttons button')]
	assert.deepEqual(
		buttons.map((button) => button.textContent),
		['Shell', 'pi', 'opencode']
	)
	buttons[1].dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	assert.deepEqual(
		h.calls.filter(([name]) => name === 'terminalOpenLocal'),
		[['terminalOpenLocal', 'pi']]
	)
})

await test('a program that is not installed is disabled, and says why on hover', async () => {
	// Hiding it would leave the operator unable to tell "this build has the feature"
	// from "this machine cannot run it". The tooltip is the whole message.
	const h = harness({
		state: { activeId: 'local', tabs: [] },
		devices: [],
		presets: [
			{ id: 'shell', label: 'Shell', available: true },
			{ id: 'pi', label: 'pi', available: false, reason: 'pi was not found on PATH' },
			{ id: 'opencode', label: 'opencode', available: false, reason: 'opencode was not found on PATH' }
		]
	})
	await h.flush()
	h.document.getElementById('add').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	await h.flush()
	const buttons = [...h.popover().querySelectorAll('.local-buttons button')]
	const pi = buttons.find((button) => button.textContent === 'pi')
	assert.equal(pi.disabled, true)
	assert.match(pi.title, /pi was not found on PATH/u)
	assert.equal(buttons[0].disabled, false, 'the shell is always available')
})

await test('the add form submits the fields it was given', async () => {
	const h = harness({ state: { activeId: 'local', tabs: [] }, devices: [] })
	await h.flush()
	h.document.getElementById('add').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	await h.flush()
	const form = h.popover().querySelector('form')
	form.querySelector('input[name=label]').value = 'box-b'
	form.querySelector('input[name=host]').value = '10.0.0.3'
	form.querySelector('input[name=user]').value = 'builder'
	form.querySelector('input[name=sshPort]').value = ''
	form.querySelector('input[name=directory]').value = ''
	form.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }))
	await h.flush()
	const saved = h.calls.find(([name]) => name === 'save')
	assert.ok(saved !== undefined, 'save was never called')
	assert.equal(saved[1].host, '10.0.0.3')
	assert.equal(saved[1].user, 'builder')
	assert.equal(saved[1].label, 'box-b')
	// The port field is passed through as the operator left it, and an empty one goes
	// out as an empty string. That is deliberately **not** a shape disagreement: the
	// main process's `normalizePort` reads `''` as the documented way to say "not
	// specified" and answers 22, while anything that is not a whole number in range is
	// refused with a message. The previous wording here claimed the empty string must
	// not be sent, which contradicted the line below it — and the line was right.
	assert.equal(saved[1].sshPort, '')
})

await test('the add form submits extra addresses with the device', async () => {
	const h = harness({ state: { activeId: 'local', tabs: [] }, devices: [] })
	await h.flush()
	h.document.getElementById('add').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	await h.flush()
	const form = h.popover().querySelector('form')
	form.querySelector('input[name=host]').value = '10.0.0.2'
	form.querySelector('input[name=user]').value = 'deploy'
	form.querySelector('textarea[name=addresses]').value = 'Tailscale=10.0.0.3'
	form.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }))
	await h.flush()
	const saved = h.calls.find(([name]) => name === 'save')
	// jsdom crosses a realm here, so the objects are not reference-equal to this
	// file's own literals even when their contents agree.
	assert.deepEqual(JSON.parse(JSON.stringify(saved[1].addresses)), [{ host: '10.0.0.3', label: 'Tailscale' }])
	assert.equal(saved[1].addressChoice, 'auto')
})

await test('a device row offers auto and every address, and saves a choice', async () => {
	const h = harness({
		state: { activeId: 'local', tabs: [] },
		devices: [{ id: 'dev-a', label: 'box-a', user: 'u', host: '10.0.0.2', sshPort: 22, addresses: [{ host: '10.0.0.3', label: 'Tailscale' }], addressChoice: 'auto' }]
	})
	await h.flush()
	h.document.getElementById('add').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	await h.flush()
	const select = h.popover().querySelector('.row select.address-select')
	assert.ok(select !== null, 'the device row has no address choice')
	assert.deepEqual([...select.options].map((option) => option.value), ['auto', '10.0.0.2', '10.0.0.3'])
	select.value = '10.0.0.3'
	select.dispatchEvent(new h.window.Event('change', { bubbles: true }))
	await h.flush()
	const saved = h.calls.find(([name]) => name === 'save')
	assert.ok(saved !== undefined, 'the choice was not written to the book')
	assert.equal(saved[1].addressChoice, '10.0.0.3')
})

await test('the address editor can change the primary address and the list', async () => {
	const h = harness({
		state: { activeId: 'local', tabs: [] },
		devices: [{ id: 'dev-a', label: 'box-a', user: 'u', host: '10.0.0.2', sshPort: 22, addresses: [{ host: '10.0.0.3', label: 'Tailscale' }], addressChoice: 'auto' }]
	})
	await h.flush()
	h.document.getElementById('add').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	await h.flush()
	const row = h.popover().querySelector('.row')
	const editor = row.querySelector('.address-editor')
	assert.equal(editor.hidden, true)
	row.querySelector('button.address-edit').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	assert.equal(editor.hidden, false)
	const area = editor.querySelector('textarea')
	assert.equal(area.value, '10.0.0.2\nTailscale=10.0.0.3')
	area.value = '10.0.0.3\nLAN=10.0.0.2'
	editor.querySelector('button').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	const saved = h.calls.find(([name]) => name === 'save')
	assert.equal(saved[1].host, '10.0.0.3')
	assert.deepEqual(JSON.parse(JSON.stringify(saved[1].addresses)), [{ host: '10.0.0.2', label: 'LAN' }])
	assert.equal(saved[1].addressChoice, 'auto')
})

await test('a device card keeps actions, addressing and the editor on separate lines', async () => {
	// Reported from use: with several IPs configured, the address picker, the
	// buttons and the inline editor were siblings in one 380px flex row and drew
	// on top of one another. The card now gives each group its own line, and the
	// editor is a sibling of the address line rather than a cramped flex child.
	const h = harness({
		state: { activeId: 'local', tabs: [] },
		devices: [{
			id: 'dev-a', label: 'box-a', user: 'u', host: '10.0.0.2', sshPort: 22,
			addresses: [{ host: '10.0.0.3', label: 'Tailscale' }, { host: '192.0.2.4', label: 'LAN' }]
		}]
	})
	await h.flush()
	h.document.getElementById('add').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	await h.flush()
	const row = h.popover().querySelector('.row')
	assert.ok(row.querySelector('.row-actions') !== null, 'the action controls have no line of their own')
	const addressLine = row.querySelector('.row-address')
	assert.ok(addressLine !== null, 'the addressing controls have no line of their own')
	const editor = row.querySelector('.address-editor')
	assert.equal(editor.parentElement, row, 'the editor is still packed into another control row')
	assert.equal(addressLine.parentElement, row)
	assert.equal(addressLine.querySelectorAll('button.address-edit').length, 1)
	assert.match(editor.textContent, /first is primary/u)
	assert.equal(editor.querySelector('textarea').value, '10.0.0.2\nTailscale=10.0.0.3\nLAN=192.0.2.4')
})

await test('a rejected save surfaces the reason instead of failing silently', async () => {
	const h = harness({ state: { activeId: 'local', tabs: [] }, devices: [] })
	await h.flush()
	h.document.getElementById('add').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	await h.flush()
	h.failNextSave('host and user are required')
	const form = h.popover().querySelector('form')
	form.querySelector('input[name=host]').value = 'h'
	form.querySelector('input[name=user]').value = 'u'
	form.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }))
	await h.flush()
	await h.flush()
	assert.match(h.popover().textContent, /host and user are required/u)
})

await test('what the book had to leave out is shown, not swallowed', async () => {
	// The book is a file the operator edits by hand, and a record the checks reject is
	// *dropped* rather than repaired. Absent from the list below is the one thing they
	// cannot notice, and the reason lives in `devices:list`'s `problems` — so it has to
	// reach the panel, above the devices it is about.
	const h = harness({ state: { activeId: 'local', tabs: [] }, devices: [] })
	h.setProblems(['the device "box-b" was left out of the book: the ssh port has to be a whole number between 1 and 65535, and "2222x" is not one'])
	await h.flush()
	h.document.getElementById('add').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	await h.flush()
	assert.match(h.popover().textContent, /box-b/u, `the dropped device is not named: ${h.popover().textContent}`)
	assert.match(h.popover().textContent, /whole number between 1 and 65535/u, 'the reason is not shown')
	// And with a clean book the panel says nothing about ports.
	const clean = harness({ state: { activeId: 'local', tabs: [] }, devices: [] })
	clean.setProblems([])
	await clean.flush()
	clean.document.getElementById('add').dispatchEvent(new clean.window.MouseEvent('click', { bubbles: true }))
	await clean.flush()
	await clean.flush()
	assert.doesNotMatch(clean.popover().textContent, /left out of the book/u)
})

/** A running terminal tab, plus the device tab and the local one. */
function terminalTabs(overrides = {}) {
	return {
		activeId: 'terminal:dev-a',
		tabs: [
			{ id: 'local', kind: 'local', label: 'Local', state: 'running', url: 'http://127.0.0.1:1000/' },
			{ id: 'dev-a', kind: 'remote', label: 'box-a', state: 'idle' },
			{
				id: 'terminal:dev-a',
				kind: 'terminal',
				deviceId: 'dev-a',
				label: 'box-a — terminal',
				state: 'running',
				generation: 1,
				...overrides
			}
		]
	}
}

console.log('terminals')

await test('a local terminal tab gets a terminal and no guest', async () => {
	// A local tab is a terminal with no device, and the distinction that matters in
	// the renderer is that it must not be given a partition and turned into a
	// `<webview>`: there is no URL behind it.
	const h = harness({
		state: {
			activeId: 'terminal:local:1',
			tabs: [
				{ id: 'local', kind: 'local', label: 'Local', state: 'running', url: 'http://127.0.0.1:1000/' },
				{
					id: 'terminal:local:1',
					kind: 'terminal',
					local: true,
					preset: 'pi',
					cwd: '<root>\\project',
					label: 'pi — project',
					state: 'running',
					generation: 1
				}
			]
		},
		devices: []
	})
	await h.flush()
	assert.equal(h.terminalHosts().length, 1, 'the local terminal tab drew no terminal')
	assert.equal(h.guests().length, 1, 'the local tab was turned into a guest as well')
	assert.deepEqual(
		h.calls.filter(([name]) => name === 'terminalAttach'),
		[['terminalAttach', 'terminal:local:1']],
		'the local session was never told there is a screen'
	)
	// The label shortens to the folder's last segment; the tooltip is where the
	// directory an operator actually chose survives.
	assert.match(h.tabs()[1].title, /in <root>\\project/u)
})

await test('a terminal tab gets one emulator, attaches once and fits to its host', async () => {
	const h = harness({ state: terminalTabs(), devices: [] })
	await h.flush()
	assert.equal(h.terminalHosts().length, 1, 'the tab drew no terminal host')
	assert.equal(h.terminals.length, 1, 'the tab created more than one emulator')
	assert.deepEqual(
		h.calls.filter(([name]) => name === 'terminalAttach'),
		[['terminalAttach', 'terminal:dev-a']],
		'the main process was not told there is a screen'
	)
	// The fit happens after the host is on screen, and its measurement is what the
	// pty is told; an 80x24 default would wrap a wide shell at the wrong place.
	assert.deepEqual(h.calls.filter(([name]) => name === 'terminalResize').at(-1), ['terminalResize', 'terminal:dev-a', 120, 30])

	// A repeated state push must reuse both the host and the emulator: rebuilding
	// either would throw away the scrollback the operator is reading.
	const term = h.terminals[0]
	h.pushState(terminalTabs())
	await h.flush()
	assert.equal(h.terminals.length, 1)
	assert.equal(h.terminals[0], term)
	assert.equal(h.calls.filter(([name]) => name === 'terminalAttach').length, 1)
})

await test('output is written to the emulator it belongs to', async () => {
	const state = terminalTabs()
	state.tabs.push({
		id: 'terminal:dev-b',
		kind: 'terminal',
		deviceId: 'dev-b',
		label: 'box-b — terminal',
		state: 'running',
		generation: 1
	})
	const h = harness({ state, devices: [] })
	await h.flush()
	assert.equal(h.terminals.length, 2)
	const [first, second] = h.terminals
	h.pushTerminalData({ id: 'terminal:dev-b', data: 'box-b$ ' })
	assert.deepEqual(second.writes, ['box-b$ '])
	assert.deepEqual(first.writes, [], 'output for one tab was drawn in another')
	// A payload for a tab that has been closed — an in-flight chunk racing the
	// state push — is dropped rather than thrown.
	h.pushTerminalData({ id: 'terminal:gone', data: 'too late' })
})

await test('a reconnect clears the screen and attaches to the new session', async () => {
	const h = harness({ state: terminalTabs(), devices: [] })
	await h.flush()
	const term = h.terminals[0]
	h.pushState(terminalTabs({ generation: 2, state: 'starting' }))
	await h.flush()
	assert.equal(term.resets, 1, "the previous session's screen was kept")
	assert.equal(h.calls.filter(([name]) => name === 'terminalAttach').length, 2)
	assert.match(h.terminalHosts()[0].textContent, /opening the ssh session/u)
})

await test('an ended session keeps its output and offers Reconnect', async () => {
	const h = harness({ state: terminalTabs(), devices: [] })
	await h.flush()
	const term = h.terminals[0]
	term.write('last words')
	h.pushState(terminalTabs({ state: 'ended', exitCode: 255 }))
	await h.flush()
	const host = h.terminalHosts()[0]
	assert.match(host.textContent, /session ended \(exit code 255\)/u)
	assert.equal(term.resets, 0, 'the transcript was cleared when the session ended')
	assert.equal(h.panels().length, 0, 'a panel covered the terminal the operator was reading')
	const again = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Reconnect')
	assert.ok(again !== undefined, 'the ended terminal has no way back')
	again.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	assert.deepEqual(
		h.calls.filter(([name]) => name === 'restart'),
		[['restart', 'terminal:dev-a']]
	)
})

await test('a terminal tab that is closed disposes its emulator and its host', async () => {
	const h = harness({ state: terminalTabs(), devices: [] })
	await h.flush()
	const term = h.terminals[0]
	h.pushState({ activeId: 'local', tabs: terminalTabs().tabs.filter((tab) => tab.kind !== 'terminal') })
	await h.flush()
	assert.equal(term.disposed, 1, 'the emulator outlived its tab')
	assert.equal(h.terminalHosts().length, 0)
	// The device tab is still there, because it is a configured thing.
	assert.deepEqual(h.tabs().map((tab) => tab.querySelector('.tab-label').textContent), ['Local', 'box-a'])
})

await test('typing into a terminal reaches its pty', async () => {
	const h = harness({ state: terminalTabs(), devices: [] })
	await h.flush()
	h.terminals[0].type('ls\r')
	assert.deepEqual(
		h.calls.filter(([name]) => name === 'terminalInput'),
		[['terminalInput', 'terminal:dev-a', 'ls\r']]
	)
})

await test('the popover offers a terminal for a device and asks the main process for it', async () => {
	const h = harness({
		state: { activeId: 'local', tabs: [{ id: 'local', kind: 'local', label: 'Local', state: 'running', url: 'http://127.0.0.1:1000/' }] },
		devices: [{ id: 'dev-a', label: 'box-a', user: 'u', host: '10.0.0.2', sshPort: 22 }]
	})
	await h.flush()
	h.document.getElementById('add').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	await h.flush()
	const buttons = [...h.popover().querySelectorAll('button')].map((button) => button.textContent)
	assert.ok(buttons.includes('Terminal'), `the device row has no terminal control: ${JSON.stringify(buttons)}`)
	// The remove control keeps its own class, because the terminal button must not
	// inherit the destructive red hover.
	assert.ok(h.popover().querySelector('button.danger') !== null)
	const open = [...h.popover().querySelectorAll('button')].find((button) => button.textContent === 'Terminal')
	open.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	assert.deepEqual(
		h.calls.filter(([name]) => name === 'terminalOpen'),
		[['terminalOpen', 'dev-a']]
	)
	assert.equal(h.popover().hidden, true, 'the popover stayed open over the new tab')
})

console.log(`\n${String(passes)} checks passed${failures.length === 0 ? '' : `, ${String(failures.length)} failed`}`)
if (failures.length > 0) process.exitCode = 1
