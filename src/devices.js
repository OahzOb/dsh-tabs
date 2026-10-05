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
 * The device ids this application's own chrome already uses.
 *
 * A device id is not just a key in a file: `main.js` builds one tab per id and
 * looks tabs up by it, and `local` is the id of the tab that is not a device at
 * all. A book carrying a device with that id therefore does not merely collide —
 * `devices:list` overwrites the local tab's label with the device's, and
 * `devices:remove('local')` tears the local Harness down and deletes its tab for
 * the rest of the session, because nothing recreates it after `ensureLocal` has
 * run once at boot. Both were reproduced with a hand-edited book.
 *
 * The book is documented as hand-editable, so this is a rule the operator can
 * break by accident and has to be told about, not one to assume away.
 *
 * @type {readonly string[]}
 */
const RESERVED_IDS = Object.freeze(['local'])

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
 * Why records were left out of the book on the last load, for the operator.
 *
 * A dropped record has to be *said*, not merely survived: the book is the file the
 * operator edits by hand, so a device that vanished between launches is their bug
 * to find, and this is the only part of the application that knows what was wrong
 * with it. Appended to for the life of the process and de-duplicated, rather than
 * replaced per load: the loads that follow the interesting one — `persistPlatform`
 * writes the book off the back of every activation — would otherwise wipe the
 * message before anybody had read it.
 *
 * @type {string[]}
 */
let lastProblems = []

/**
 * The rules a record has to satisfy beside the shape `normalize` gives it.
 *
 * Both are reachable from a hand-edited book *and* from the popover, and both are
 * silent when broken, which is why one function is the only place either is
 * decided.
 *
 * @param device - the normalized record.
 * @param others - the records it will sit beside.
 * @returns an error message, or null when the record is acceptable.
 */
function validate(device, others) {
	if (RESERVED_IDS.includes(device.id)) {
		return `a device cannot use the id "${device.id}": this application's own ${device.id} tab uses it`
	}
	if (others.some((entry) => entry.id === device.id)) {
		return `another device already uses the id "${device.id}", and one id is one tab`
	}
	return null
}

/**
 * The same two rules, asked about one id against the book it is about to join.
 *
 * `normalize` sees a single record and cannot check either of them — uniqueness is
 * a property of the list — so the save path asks here instead, and gets a message
 * it can hand straight to the operator.
 *
 * @param id - the id the record will carry.
 * @param book - every record in the book.
 * @param replacing - the record being replaced, when this is an edit.
 * @returns an error message, or null when the id is acceptable.
 */
function validateId(id, book, replacing) {
	return validate({ id }, book.filter((entry) => entry !== replacing))
}

/**
 * Name a raw record the way whoever wrote it would recognise it.
 * @param entry - whatever the book held.
 * @returns a short description.
 */
function describe(entry) {
	const label = entry !== null && typeof entry === 'object' ? entry.label ?? entry.id : undefined
	return typeof label === 'string' && label !== '' ? `the device "${label}"` : 'a device with no label'
}

/**
 * Load the device book, seeding it once from the plugin's book when this app has
 * never run before.
 *
 * **A record the book cannot hold is dropped and reported, and the report is
 * worded for somebody who is about to open the file.** Both halves of that are
 * deliberate. Dropping: a record that cannot be normalized is a typo or an
 * attack, and the rest of the book is not made worse by its absence. Reporting
 * rather than throwing: throwing would turn one bad record into an application
 * that does not start, and the file is a JSON document with no editor inside the
 * window, so the operator would be locked out of the thing that would tell them.
 *
 * `normalize` runs over every stored record on the way in. It did not before, so
 * a hand-written record reached the rest of the application exactly as written: a
 * `sshPort` of `'2222x'` went on to `ssh -p`, a device with the id `local` was
 * handed to `tabFor` and took the local tab over — label, stop button and all —
 * and two records sharing an id collapsed into one tab.
 *
 * @returns the stored devices, normalized and de-duplicated.
 */
async function load() {
	/** @type {string[]} */
	const problems = []
	/**
	 * Normalize and check one array of raw records.
	 * @param entries - the raw records.
	 * @returns the ones that may be kept, in order.
	 */
	const keep = (entries) => {
		const devices = []
		for (const entry of entries) {
			let device
			try {
				// `previous` is the record itself: that is how the cached shell family
				// survives a rebuild that takes every other field from the whitelist.
				device = normalize(entry, entry)
			} catch (error) {
				problems.push(`${describe(entry)} was left out of the book: ${error instanceof Error ? error.message : String(error)}`)
				continue
			}
			const problem = validate(device, devices)
			if (problem !== null) {
				problems.push(`${describe(entry)} was left out of the book: ${problem}`)
				continue
			}
			devices.push(device)
		}
		return devices
	}

	let raw
	const stored = await readFile(STORE_PATH, 'utf8').catch(() => undefined)
	if (stored !== undefined) {
		try {
			const parsed = JSON.parse(stored)
			if (Array.isArray(parsed?.devices)) raw = parsed.devices
			else problems.push('the device book has no "devices" array, so no devices were loaded from it')
		} catch (error) {
			problems.push(`the device book is not readable JSON (${error instanceof Error ? error.message : String(error)}), so no devices were loaded from it`)
		}
	} else if (await exists(SEED_PATH)) {
		try {
			const seeded = JSON.parse(await readFile(SEED_PATH, 'utf8'))
			if (Array.isArray(seeded?.devices) && seeded.devices.length > 0) raw = seeded.devices
		} catch {
			/* a damaged seed is not a reason to fail: start empty */
		}
	}

	const devices = raw === undefined ? [] : keep(raw)
	// Appended, not replaced, and de-duplicated. A clean load adds nothing: what is
	// remembered is about a file the operator may not have looked at yet, and the
	// loads that follow the interesting one — `persistPlatform` writes the book off
	// the back of every activation — would otherwise wipe the message before anybody
	// had read it. The de-duplication is what stops the same complaint being made
	// once per load for as long as the book stays wrong.
	for (const problem of problems) {
		if (!lastProblems.includes(problem)) lastProblems.push(problem)
	}
	// One write, and only when there is something to write. A launch with a clean
	// book must not touch the file at all — and a book that could not be read is
	// never written, because that would replace a file somebody is midway through
	// fixing with the empty list this load produced from it.
	if (raw !== undefined && problems.length > 0) await save(devices)
	return devices
}

/**
 * Persist the device book.
 * @param devices - the complete device list.
 */
async function save(devices) {
	// The last door before the file. `load` checks every record it reads, but a
	// caller can hand `save` anything, and the two rules it checks are the two whose
	// violation is silent: a duplicate id is a tab that quietly disappears, and a
	// reserved id is this application's own tab being overwritten.
	for (const device of devices) {
		const problem = validate(
			device,
			devices.filter((entry) => entry !== device)
		)
		if (problem !== null) throw new Error(`refusing to write the book: ${problem}`)
	}
	await mkdir(HOME_DIR, { recursive: true })
	await writeFile(STORE_PATH, `${JSON.stringify({ devices }, null, 2)}\n`, 'utf8')
}

/**
 * What the last load had to leave out.
 * @returns the messages, oldest first.
 */
function problems() {
	return [...lastProblems]
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
 * Throws on a port it cannot use, for the same reason `remote.directoryProblem`
 * refuses a directory: the alternative is a value that reaches a program as
 * something other than what the operator wrote. `Number('2222x') || 22` is a
 * silent 22, and `-5` is accepted by `Number` and passed straight to `ssh -p -5`.
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
		sshPort: normalizePort(incoming?.sshPort),
		// No port field: the remote picks its own, so nothing about a previous
		// session's port is retained.
		...(directory === undefined ? {} : { directory }),
		...(platform === undefined ? {} : { platform })
	}
}

/**
 * The ssh port, or a refusal.
 *
 * A port is the one numeric field in the book, it is editable by hand, and it
 * ends up as an argv element of `ssh`. Anything that is not a whole number in
 * range is refused rather than defaulted: an operator who typed `2222x` wants to
 * hear about the `x`, not to be connected to port 22 and left wondering. An empty
 * field is the ordinary case of "not specified" and takes the default, which is
 * what the popover and the plugin's own schema both mean by it.
 *
 * @param value - the submitted value, a number or a string.
 * @returns the port number.
 */
function normalizePort(value) {
	if (value === undefined || value === null || value === '' || value === false) return DEFAULT_SSH_PORT
	const port = typeof value === 'number' ? value : Number(String(value).trim())
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`the ssh port has to be a whole number between 1 and 65535, and "${String(value)}" is not one`)
	}
	return port
}

module.exports = { STORE_PATH, SEED_PATH, RESERVED_IDS, load, save, mutate, normalize, normalizePort, problems, validateId }
