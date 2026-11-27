/**
 * Refuse to mistake the operator's own home for a scratch directory.
 *
 * Both suites delete the directory they are handed — `rmSync` on a scratch home
 * is how a run starts from a known-empty world — and `DSH_TABS_TEST_HOME` is the
 * documented escape hatch for environments that refuse to create a directory
 * anywhere else. It used to be honoured exactly as given, which meant a shell
 * exporting it as the home directory turned `npm test` into a recursive delete of
 * the operator's profile. This module exists to make that accident impossible:
 * `scratchProblem` answers one question — may this path be deleted wholesale? —
 * and `assertScratch` throws when the answer is no.
 *
 * The suites fail loudly instead of falling back to a safe default. A silent
 * fallback would hide the misconfiguration that made the delete dangerous.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

/**
 * Whether `parent` is `child` itself or one of its ancestors.
 *
 * `relative` is what makes this correct without string prefixes: a name that
 * merely begins with a sibling's name is still a sibling, not a descendant, so
 * no text comparison can stand in for it.
 *
 * @param parent - the candidate ancestor.
 * @param child - the path that may live under it.
 * @returns true when `child` is `parent` or inside it.
 */
function contains(parent, child) {
	const rel = relative(parent, child)
	if (rel === '') return true
	return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

/**
 * Directories that are never a scratch directory, whatever the shell says.
 * @returns resolved system paths.
 */
function systemDirectories() {
	const named = [
		process.env.SystemRoot,
		process.env.ProgramFiles,
		process.env['ProgramFiles(x86)'],
		process.env.ProgramData,
		process.env.SystemDrive === undefined ? undefined : join(process.env.SystemDrive, 'Users')
	]
	return named.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => resolve(entry))
}

/**
 * Why `candidate` must not be deleted, or null when it is a plausible scratch.
 *
 * @param candidate - the directory a suite is about to create or remove.
 * @param alsoProtect - paths that must survive even when they are not a home.
 * @returns the reason it is refused, or null.
 */
export function scratchProblem(candidate, alsoProtect = []) {
	if (typeof candidate !== 'string' || candidate.trim() === '') return 'is empty'
	const target = resolve(candidate)
	const home = resolve(homedir())
	if (parse(target).name === '') return 'is a drive or filesystem root'
	if (target === home) return "is the operator's home directory"
	if (target === resolve(join(home, '.dsh'))) return "is the operator's DSH home"
	if (contains(target, home)) return "contains the operator's home directory"
	for (const blocked of systemDirectories()) {
		if (target === blocked) return `is a system directory (${blocked})`
	}
	for (const keep of alsoProtect) {
		const kept = resolve(keep)
		if (target === kept || contains(target, kept)) return `would delete ${kept}`
	}
	// A real Harness home keeps its state in `.dsh`; a directory holding one is
	// somebody's home rather than a scratch, even when it is not this operator's.
	if (existsSync(join(target, '.dsh'))) return 'already holds a DSH home (.dsh)'
	return null
}

/**
 * Resolve `candidate`, or throw with the reason it is not disposable.
 *
 * @param candidate - the directory a suite is about to create or remove.
 * @param options - `label` for the message, and `alsoProtect` paths to keep.
 * @returns the resolved path.
 */
export function assertScratch(candidate, { label = 'scratch directory', alsoProtect = [] } = {}) {
	const problem = scratchProblem(candidate, alsoProtect)
	if (problem !== null) {
		throw new Error(`${label} ${problem}: ${String(candidate)} — refusing to delete it`)
	}
	return resolve(candidate)
}
