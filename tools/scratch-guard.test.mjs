/**
 * The guard's own regression check.
 *
 * `scratch-guard.mjs` exists because `DSH_TABS_TEST_HOME` used to be trusted as
 * given and then deleted with `rmSync`. A guard that is only exercised by the
 * suite that also deletes directories is a guard nobody notices regressing, so
 * it is checked here, on its own, before any suite runs.
 */

import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scratchProblem } from './scratch-guard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const home = resolve(homedir())

/** [path, must be refused] */
const cases = [
	[home, true],
	[join(home, '.dsh'), true],
	[dirname(home), true],
	[parse(home).root, true],
	[home + '-not-the-home', false],
	[join(tmpdir(), 'dsh-tabs-guard-test'), false],
	[join(ROOT, '.tmp-guard-test'), false]
]

for (const [candidate, refused] of cases) {
	const problem = scratchProblem(candidate)
	assert.equal(problem !== null, refused, `${candidate} -> ${String(problem)}`)
}

assert.notEqual(scratchProblem(ROOT, [ROOT]), null, 'the repository root itself was treated as a scratch')
assert.notEqual(scratchProblem(dirname(ROOT), [ROOT]), null, 'a parent of the repository was treated as a scratch')
assert.equal(scratchProblem(join(ROOT, '.tmp-main-test'), [ROOT, home]), null, 'a scratch inside the repository was refused')
assert.equal(scratchProblem(join(ROOT, '.tmp-guard-test'), [ROOT, home]), null, 'a scratch inside the repository was refused')

console.log('scratch guard: ok')