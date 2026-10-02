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
	disconnect: (id) => ipcRenderer.invoke('tabs:disconnect', id),
	devices: () => ipcRenderer.invoke('devices:list'),
	open: (id) => ipcRenderer.invoke('devices:open', id),
	save: (device) => ipcRenderer.invoke('devices:save', device),
	remove: (id) => ipcRenderer.invoke('devices:remove', id),
	transcript: (id) => ipcRenderer.invoke('devices:transcript', id),
	onState: (listener) => subscribe('tabs:state', listener),
	onShortcut: (listener) => subscribe('tabs:shortcut', listener)
})
