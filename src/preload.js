'use strict'

/**
 * The renderer's whole view of the main process.
 *
 * It is an explicit list rather than a generic `invoke` passthrough: the page
 * runs remote web UIs, and a channel that could name any IPC target would hand
 * that content more reach than it should ever have.
 */

const { contextBridge, ipcRenderer } = require('electron')

/**
 * Subscribe to one main-process push channel.
 * @param channel - the channel name.
 * @param listener - the callback.
 * @returns a disposer.
 */
function subscribe(channel, listener) {
	const handler = (_event, payload) => {
		listener(payload)
	}
	ipcRenderer.on(channel, handler)
	return () => {
		ipcRenderer.off(channel, handler)
	}
}

contextBridge.exposeInMainWorld('dshTabs', {
	platform: process.platform,
	state: () => ipcRenderer.invoke('tabs:get'),
	activate: (id) => ipcRenderer.invoke('tabs:activate', id),
	select: (id) => ipcRenderer.invoke('tabs:select', id),
	disconnect: (id) => ipcRenderer.invoke('tabs:disconnect', id),
	restart: (id) => ipcRenderer.invoke('tabs:restart', id),
	// The one control that ends a persistent host. Separate from `disconnect`, which
	// lets go and leaves it running.
	reap: (id) => ipcRenderer.invoke('tabs:reap', id),
	devices: () => ipcRenderer.invoke('devices:list'),
	open: (id) => ipcRenderer.invoke('devices:open', id),
	save: (device) => ipcRenderer.invoke('devices:save', device),
	remove: (id) => ipcRenderer.invoke('devices:remove', id),
	transcript: (id) => ipcRenderer.invoke('devices:transcript', id),
	checkUpdates: () => ipcRenderer.invoke('updates:check'),
	terminalOpen: (id) => ipcRenderer.invoke('terminal:open', id),
	terminalPresets: () => ipcRenderer.invoke('terminal:presets'),
	terminalOpenLocal: (preset) => ipcRenderer.invoke('terminal:openLocal', preset),
	terminalAttach: (id) => ipcRenderer.invoke('terminal:attach', id),
	// One-way on purpose: a keystroke is hot, and an `invoke` would wrap every key
	// in a promise the renderer has no use for. The main process validates both.
	terminalInput: (id, data) => ipcRenderer.send('terminal:input', id, data),
	terminalResize: (id, cols, rows) => ipcRenderer.send('terminal:resize', id, cols, rows),
	// The clipboard is reached in the main process. `clipboard` is not one of the
	// modules a preload gets from `require('electron')`, so a preload-side copy is
	// `undefined` until somebody actually copies something.
	clipboard: {
		read: () => ipcRenderer.invoke('clipboard:read'),
		write: (text) => ipcRenderer.invoke('clipboard:write', text)
	},
	onState: (listener) => subscribe('tabs:state', listener),
	onTerminalData: (listener) => subscribe('terminal:data', listener),
	onShortcut: (listener) => subscribe('tabs:shortcut', listener)
})