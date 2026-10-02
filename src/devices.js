'use strict'

/**
 * The device book.
 *
 * The schema is deliberately identical to the `dsh-remote-devices` plugin's, so
 * the two surfaces agree on what a device is. The file is separate, though: two
 * processes writing one JSON file would clobber each other, and this app must
 * not corrupt a book the Desktop plugin is still using. On first run the plugin's
 * book is copied over, so an operator who already configured devices there finds
 * them waiting here.
 */

const { mkdir, readFile, writeFile, access } = require('node:fs/promises')
const { join } = require('node:path')
const { homedir } = require('node:os')
const { DEFAULT_SSH_PORT } = require('./remote.js')

const HOME_DIR = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const STORE_PATH = join(HOME_DIR, 'dsh-tabs.json')
const SEED_PATH = join(HOME_DIR, 'remote-devices.json')

/**
 * The shape every stored device is normalized to.
 *
 * @typedef {object} Device
 * @property {string} id
 * @property {string} label
 * @property {string} transport
 * @property {string} host
 * @property {string} user
 * @property {number} sshPort
 * @property {string} [directory]
 * @property {'posix'|'windows'} [platform]
 */

/**
 * @returns true when a path exists.
 */
async function exists(path) {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

/**
 * Load the device book, seeding it once from the plugin's book when this app has
 * never run before.
 * @returns the stored devices.
 */
async function load() {
	try {
		const parsed = JSON.parse(await readFile(STORE_PATH, 'utf8'))
		return Array.isArray(parsed?.devices) ? parsed.devices : []
	} catch {
		/* fall through to the seed */
	}
	if (await exists(SEED_PATH)) {
		try {
			const seeded = JSON.parse(await readFile(SEED_PATH, 'utf8'))
			if (Array.isArray(seeded?.devices) && seeded.devices.length > 0) {
				await save(seeded.devices)
				return seeded.devices
			}
		} catch {
			/* a damaged seed is not a reason to fail: start empty */
		}
	}
	return []
}

/**
 * Persist the device book.
 * @param devices - the complete device list.
 */
async function save(devices) {
	await mkdir(HOME_DIR, { recursive: true })
	await writeFile(STORE_PATH, `${JSON.stringify({ devices }, null, 2)}\n`, 'utf8')
}

/**
 * The tail of the chain of book mutations, so only one runs at a time.
 * @type {Promise<unknown>}
 */
let mutations = Promise.resolve()

/**
 * Change the book by read-modify-write, one caller at a time.
 *
 * `load()` followed by `save()` is a *lost update* when anything else can write
 * in between: the second writer's copy is the one that survives, and everything
 * the first one changed is gone. Measured on this project — clicking a device
 * whose shell family had not been cached yet, then editing the book from the
 * popover, could resurrect a device that had just been removed, or drop an edit
 * that had just been saved. The interleaving is easy to hit here because every
 * tab activation persists a detected platform, and nothing serialized those
 * writes against the popover's.
 *
 * Chaining every mutation onto one promise makes each read-modify-write atomic
 * with respect to the others in this process. That is the whole contract: an
 * editor that reads the book outside this function is still reading whatever has
 * been written, which is the best a plain JSON file offers.
 *
 * A `change` that returns `undefined` leaves the book as it found it, which is
 * how a caller whose device has since been removed declines to write at all.
 *
 * @param change - receives the current devices and returns the new list, or undefined to write nothing.
 * @returns what `change` returned, or undefined when it declined to write.
 */
function mutate(change) {
	const next = mutations.then(async () => {
		const stored = await load()
		const updated = await change(stored)
		if (updated === undefined) return undefined
		await save(updated)
		return updated
	})
	// The chain must survive a failed link, or one rejected mutation would reject
	// every mutation after it with the same stale error.
	mutations = next.catch(() => {})
	return next
}

/**
 * Rebuild one device from untrusted input.
 *
 * The record is rebuilt from a whitelist rather than merged, so an unexpected
 * field can never reach the store. The detected shell family is the one field
 * that has to survive an edit: dropping it would silently re-probe the far side
 * on the next connect.
 *
 * @param incoming - the submitted device fields.
 * @param previous - the stored record being replaced, when there is one.
 * @returns the normalized device.
 */
function normalize(incoming, previous) {
	const id = typeof incoming?.id === 'string' && incoming.id !== '' ? incoming.id : `dev-${Date.now().toString(36)}`
	const incomingPlatform = incoming?.platform
	const platform = incomingPlatform === 'posix' || incomingPlatform === 'windows'
		? incomingPlatform
		: previous?.platform === 'posix' || previous?.platform === 'windows'
			? previous.platform
			: undefined
	const host = String(incoming?.host ?? '')
	const user = String(incoming?.user ?? '')
	const directory = typeof incoming?.directory === 'string' && incoming.directory !== '' ? incoming.directory : undefined
	return {
		id,
		label: String(incoming?.label ?? host ?? id),
		transport: 'ssh',
		host,
		user,
		sshPort: Number(incoming?.sshPort) || DEFAULT_SSH_PORT,
		// No port field: the remote picks its own, so nothing about a previous
		// session's port is retained.
		...(directory === undefined ? {} : { directory }),
		...(platform === undefined ? {} : { platform })
	}
}

module.exports = { STORE_PATH, SEED_PATH, load, save, mutate, normalize }
