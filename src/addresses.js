'use strict'

/**
 * Choosing which address of a device to reach.
 *
 * A machine can be known by more than one address — a LAN IP at home and a
 * Tailscale IP away from it — and the device book keeps them all. The first is
 * `device.host`, so a book written before this existed (and the other two
 * clients that share the schema) keeps working unchanged; the rest live in
 * `device.addresses`. `addressChoice` is either `"auto"` or one of those hosts.
 *
 * The choice is made **before** ssh starts, so every ssh call in the connect
 * path — the platform probe, the server, the tunnel — goes to the same machine
 * through the same path. Nothing here changes the remote program or the
 * protocol: this is a decision about the local end of the connection.
 */

const net = require('node:net')

/** How long one TCP reachability probe waits, in milliseconds. */
const PROBE_TIMEOUT_MS = 1500

/** The spelling of "let the client decide" in the book. */
const AUTO = 'auto'

/**
 * Strip the brackets a literal IPv6 address carries when written with a port.
 * @param host - the stored address.
 * @returns the bare address.
 */
function bare(host) {
	return String(host ?? '').trim().replace(/^\[/u, '').replace(/\]$/u, '')
}

/**
 * Whether an address is on a local network rather than an overlay.
 *
 * Only IP literals can be classified: a name might resolve to either, and a
 * guess from its spelling would be worse than treating it as "other". Tailscale's
 * `100.64/10` is deliberately **not** LAN — it is the fallback path, and calling
 * it local would put it ahead of a real LAN address.
 *
 * @param host - the address to classify.
 * @returns true for private IPv4, IPv6 ULA and link-local ranges.
 */
function isLan(host) {
	const address = bare(host)
	const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(address)
	if (ipv4 !== null) {
		const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
		if ([a, b].some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
		if (ipv4.slice(1).some((part) => Number(part) > 255)) return false
		if (a === 10) return true
		if (a === 172 && b >= 16 && b <= 31) return true
		if (a === 192 && b === 168) return true
		// An ad-hoc link is a local path too, but not the internet.
		if (a === 169 && b === 254) return true
		return false
	}
	if (address.includes(':')) {
		const first = address.slice(0, 2).toLowerCase()
		// fc00::/7 (ULA) and fe80::/10 (link-local).
		if (first === 'fc' || first === 'fd') return true
		if (first === 'fe' && '89ab'.includes(address.charAt(2).toLowerCase())) return true
	}
	return false
}

/**
 * Every address the book names, in the order it was written.
 *
 * Duplicates are dropped so one machine cannot be probed twice under two
 * spellings; the primary address wins because it is the one an older client
 * would use. A blank or non-string entry is ignored rather than handed to
 * `net.connect` or `ssh`.
 *
 * @param device - the device record.
 * @returns the addresses, each `{ host, label }`.
 */
function candidates(device) {
	const list = []
	const seen = new Set()
	/**
	 * @param value - the address to add.
	 * @param label - the operator's name for it, when there is one.
	 */
	const add = (value, label) => {
		const host = bare(value)
		if (host === '') return
		const key = host.toLowerCase()
		if (seen.has(key)) return
		seen.add(key)
		list.push({ host, label: typeof label === 'string' && label.trim() !== '' ? label.trim() : undefined })
	}
	add(device?.host, undefined)
	if (Array.isArray(device?.addresses)) {
		for (const entry of device.addresses) {
			add(entry?.host, entry?.label)
		}
	}
	return list
}

/**
 * Reachability of one address, by opening the ssh port and closing immediately.
 *
 * A TCP connect says only that something accepts the port; it is not an ssh
 * handshake and never authenticates. That is exactly the question being asked:
 * which path can carry the ssh client that is about to run.
 *
 * @param host - the address to probe.
 * @param port - the ssh port from the device record.
 * @param options - `timeoutMs`, `signal` and `cancelled`.
 * @returns true when the port accepted the connection.
 */
function probeTcp(host, port, options = {}) {
	return new Promise((resolve) => {
		const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : PROBE_TIMEOUT_MS
		const signal = options.signal
		if (signal?.aborted === true || options.cancelled?.() === true) {
			resolve(false)
			return
		}
		let socket
		let done = false
		/** Settle once, destroy the socket, and detach the abort listener. */
		const settle = (answer) => {
			if (done) return
			done = true
			clearTimeout(timer)
			signal?.removeEventListener?.('abort', onAbort)
			try {
				socket?.destroy()
			} catch {
				/* the socket may already be gone */
			}
			resolve(answer)
		}
		const onAbort = () => settle(false)
		const timer = setTimeout(() => settle(false), timeoutMs)
		try {
			socket = net.connect({ host, port, timeout: timeoutMs })
			socket.once('connect', () => settle(true))
			socket.once('error', () => settle(false))
			socket.once('timeout', () => settle(false))
		} catch {
			settle(false)
		}
		signal?.addEventListener?.('abort', onAbort, { once: true })
	})
}

/**
 * A readable name for the address that was chosen, for the transcript.
 * @param entry - the chosen address.
 * @returns e.g. `10.0.0.2 (LAN)` or `box.example.net`.
 */
function describe(entry) {
	if (entry === undefined) return 'no address'
	return `${entry.host}${entry.label === undefined ? (isLan(entry.host) ? ' (LAN)' : '') : ` (${entry.label})`}`
}

/**
 * Resolve the address a connect should use.
 *
 * A manual choice is honoured without probing: the operator asked for that
 * path, and a probe that said "unreachable" would either be ignored or turn the
 * choice into a surprise. Automatic mode probes every candidate **concurrently**
 * — sequentially, three unreachable LAN addresses would cost three timeouts
 * before Tailscale was tried — and picks the first reachable one in preference
 * order: LAN addresses first, then the rest, preserving the book's order inside
 * each group. When nothing answers, the primary address is returned anyway so
 * ssh produces its own, more precise failure; `tried` says what was tested.
 *
 * A device with a single address is returned untouched, without touching the
 * network: there is no choice to make, and a probe would only add latency to
 * every connect and terminal.
 *
 * @param device - the device record.
 * @param options - `probe`, `timeoutMs`, `signal`, `cancelled`, `onLine`.
 * @returns the resolved device and how the answer was reached.
 */
async function resolve(device, options = {}) {
	const list = candidates(device)
	const wanted = device?.addressChoice ?? AUTO
	const note = typeof options.onLine === 'function' ? options.onLine : () => {}
	const manual = wanted !== AUTO ? list.find((entry) => entry.host === wanted) : undefined
	if (manual !== undefined) {
		note(`address: ${describe(manual)} (chosen in the device book)`)
		return { device: { ...device, host: manual.host }, host: manual.host, automatic: false, tried: [], unreachable: false }
	}
	if (wanted !== AUTO && list.length > 0) {
		note(`address: the saved address ${wanted} is no longer in the book, using automatic selection`)
	}
	if (list.length <= 1) {
		const only = list[0] ?? { host: String(device?.host ?? '') }
		return { device, host: only.host, automatic: true, tried: [], unreachable: false }
	}
	const ordered = [...list].sort((left, right) => Number(isLan(right.host)) - Number(isLan(left.host)))
	const probe = typeof options.probe === 'function' ? options.probe : (host, port) => probeTcp(host, port, options)
	const answers = await Promise.all(ordered.map(async (entry) => ({
		entry,
		ok: await probe(entry.host, device?.sshPort ?? 22, options)
	})))
	if (options.signal?.aborted === true || options.cancelled?.() === true) {
		return { device, host: list[0].host, automatic: true, tried: [], unreachable: false, cancelled: true }
	}
	const first = answers.find((answer) => answer.ok)
	const chosen = first?.entry ?? list[0]
	const tried = answers.map((answer) => ({ host: answer.entry.host, reachable: answer.ok }))
	note(`address: ${describe(chosen)}${first === undefined ? ' — none of the addresses answered; trying this one anyway' : ''}`)
	return {
		device: { ...device, host: chosen.host },
		host: chosen.host,
		automatic: true,
		tried,
		unreachable: first === undefined
	}
}

module.exports = { AUTO, PROBE_TIMEOUT_MS, isLan, candidates, probeTcp, describe, resolve }
