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
	const transcripts = options.transcripts ?? {}
	let state = options.state ?? { activeId: 'local', tabs: [] }
	let devices = options.devices ?? []
	let problems = options.problems ?? []
	let onState = () => {}
	let onShortcut = () => {}
	let failSave

	window.dshTabs = {
		state: async () => state,
		activate: async (id) => {
			calls.push(['activate', id])
			return state
		},
		disconnect: async (id) => {
			calls.push(['disconnect', id])
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
		onState: (listener) => {
			onState = listener
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
		tabs: () => [...window.document.querySelectorAll('.tab')],
		guests: () => [...window.document.querySelectorAll('webview')],
		panels: () => [...window.document.querySelectorAll('.panel')],
		popover: () => window.document.getElementById('popover')
	}
}

/** The state three tabs produce: local, one running device, one idle device. */
function threeTabs() {
	return {
		activeId: 'local',
		tabs: [
			{ id: 'local', kind: 'local', label: 'Local', state: 'running', url: 'http://127.0.0.1:1000/' },
			{ id: 'dev-a', kind: 'remote', label: 'box-a', state: 'running', url: 'http://127.0.0.1:1001/?token=a' },
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

await test('a tab that stops running loses its guest', async () => {
	const h = harness({ state: threeTabs(), devices: [] })
	await h.flush()
	const next = threeTabs()
	next.tabs[1] = { id: 'dev-a', kind: 'remote', label: 'box-a', state: 'idle' }
	h.pushState(next)
	assert.equal(h.guests().length, 1)
	assert.equal(h.guests()[0].getAttribute('src'), 'http://127.0.0.1:1000/')
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

console.log('interaction')

await test('clicking a tab asks the main process to activate it', async () => {
	const h = harness({ state: threeTabs(), devices: [] })
	await h.flush()
	h.tabs()[1].dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	assert.deepEqual(h.calls.filter(([name]) => name === 'activate'), [['activate', 'dev-a']])
})

await test('the disconnect control appears only when there is something to stop', async () => {
	const h = harness({ state: threeTabs(), devices: [] })
	await h.flush()
	const tabs = h.tabs()
	// local is never stoppable, an idle device has nothing to stop, a running one does.
	assert.equal(tabs[0].querySelector('.tab-close'), null)
	assert.equal(tabs[1].querySelector('.tab-close')?.title, 'Disconnect')
	assert.equal(tabs[2].querySelector('.tab-close'), null)
	tabs[1].querySelector('.tab-close').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }))
	await h.flush()
	assert.deepEqual(h.calls.filter(([name]) => name === 'disconnect'), [['disconnect', 'dev-a']])
})

await test('a shortcut moves the selection without asking to activate', async () => {
	// The main process already ran `activate` before it sent this; asking again
	// would restart a tab that is coming up.
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

console.log(`\n${String(passes)} checks passed${failures.length === 0 ? '' : `, ${String(failures.length)} failed`}`)
if (failures.length > 0) process.exitCode = 1
