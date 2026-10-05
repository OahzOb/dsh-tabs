'use strict'

/**
 * What the local tab's Harness version has to be, and why it is checked.
 *
 * **The failure this exists for has already happened once, and it was diagnosed
 * wrongly for two days.** A shell-launched `dsh` older than the credential store's
 * format does not read that store; it asks for `DEEPSEEK_API_KEY` in the environment
 * instead and fails the first turn with
 *
 *     llm-deepseek: no API route for provider route "deepseek-official";
 *     store DEEPSEEK_API_KEY through the credentials service …
 *     MISSING_CREDENTIAL
 *
 * which names credentials as the problem. Nothing in that message mentions a version.
 * The local tab therefore looked like it needed a key exported, or like only the
 * Desktop shell could ever work, and the actual fix was `npm install -g
 * @deepseek-ai/dsh@latest` — the version on `PATH` had been two releases behind.
 *
 * **What the check buys is not correctness, it is the 45 seconds and the wrong
 * sentence.** A too-old `dsh` is not caught early; it hangs until `START_TIMEOUT_MS`
 * expires, and *then* reports a credential error, which is the least actionable
 * combination this application can produce. Saying so before the launch takes a few
 * hundred milliseconds and names the thing to change.
 *
 * The floor is `MINIMUM_VERSION`, and it is deliberately the version this application
 * has been measured working against rather than the oldest one that might work. Two
 * releases behind is known to break it; one behind has not been measured either way,
 * and a floor set optimistically is a floor that reports nothing while the operator
 * gets the credential error anyway.
 */

const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

/**
 * The oldest `dsh` the local tab is known to work with.
 *
 * `0.2.0-rc.2` is the version this application was verified against, and it is the
 * release that made the credential store readable from a shell-launched Harness. The
 * one known to be too old is `0.1.7-rc.2`.
 */
const MINIMUM_VERSION = '0.2.0-rc.2'

/** How long the probe may take. `dsh --version` answers in well under a second. */
const VERSION_TIMEOUT_MS = 20_000

/**
 * The Windows command interpreter, by absolute path.
 *
 * **The bare name is what broke the version check this module exists for, in
 * exactly the environment `connect.js` defends against.** A packaged application
 * is not launched from a developer shell, so `PATH` is not assumed there: the ssh
 * client and the local Harness are both resolved through `%SystemRoot%\System32`
 * first, and the same reasoning applies here — except here it fails *worse than
 * not at all*, because the probe is what decides whether the local tab is allowed
 * to start. A `cmd.exe` that could not be found produced no version, and the
 * refusal that followed blamed the operator's `dsh` install — sending them to
 * `npm install -g` for a problem that was a `PATH`.
 *
 * `C:\Windows` is the fallback `remote.localDshArgv` uses for an unset
 * `SystemRoot`, which is the only reason it is named rather than derived.
 *
 * @param platform - the platform the answer is for, so the decision is a pure
 *   function of its inputs and can be checked from a POSIX host.
 * @returns the path to `cmd.exe`.
 */
function windowsCommandShell(platform = process.platform) {
	const candidate = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
	// The file check only means something on the host that has that file: anywhere
	// else the path is the expected answer rather than a claim about this machine,
	// and nothing here executes it.
	return platform === 'win32' && !existsSync(candidate) ? 'cmd.exe' : candidate
}

/**
 * The command that prints a locally installed `dsh`'s version.
 *
 * Windows goes through `cmd /c` for the reason the local tab does: `dsh` resolves to a
 * `.cmd` shim there, and Node cannot execute one directly. POSIX asks for an
 * interactive login shell so the answer comes from the same `PATH` the Harness itself
 * will be started with — an nvm install puts its bin directory on `PATH` from
 * `~/.bashrc`, which a non-interactive shell never sources, so probing without `-i`
 * would report "not found" for a machine where the launch works.
 *
 * `command -v` is asked first so that a missing `dsh` is reported as missing rather
 * than as a shell error, and the version is printed as the last thing on stdout so a
 * caller reads one line.
 *
 * @param platform - the local platform.
 * @returns the argv to run.
 */
function versionArgv(platform = process.platform) {
	if (platform === 'win32') {
		return [windowsCommandShell(platform), '/c', 'dsh --version']
	}
	return ['bash', '-lic', 'command -v dsh >/dev/null 2>&1 || exit 127; dsh --version']
}

/**
 * The version out of whatever `dsh --version` printed.
 *
 * Kept apart from the spawn so the parsing can be exercised without a process, which
 * is where the interesting cases are: a version with a pre-release suffix, output with
 * the banner a future release might add above it, and a command that printed nothing
 * because it is not installed at all.
 *
 * @param output - the combined output.
 * @returns the version string, or null when there is not one.
 */
function parseVersion(output) {
	const text = String(output ?? '')
	for (const line of text.split(/\r?\n/u)) {
		const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(line.trim())
		if (match !== null) return match[1]
	}
	return null
}

/**
 * Compare two version strings, by the semver precedence rules that matter here.
 *
 * Numeric parts compare numerically rather than as strings, so `0.10.0` is newer than
 * `0.9.0`; a pre-release is older than the release it leads to, so `0.2.0-rc.2` is
 * older than `0.2.0`; and build metadata after `+` is ignored, as the specification
 * says it should be.
 *
 * @param a - one version.
 * @param b - the other.
 * @returns negative when a is older, positive when newer, zero when equal.
 */
function compareVersions(a, b) {
	const split = (version) => {
		const withoutBuild = String(version).split('+')[0]
		const [core, ...rest] = withoutBuild.split('-')
		return { core: core.split('.').map((part) => Number(part) || 0), pre: rest.join('-') }
	}
	const left = split(a)
	const right = split(b)
	for (let index = 0; index < Math.max(left.core.length, right.core.length); index += 1) {
		const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0)
		if (difference !== 0) return difference
	}
	// Equal cores: no pre-release beats any pre-release.
	if (left.pre === '' && right.pre === '') return 0
	if (left.pre === '') return 1
	if (right.pre === '') return -1
	const leftParts = left.pre.split('.')
	const rightParts = right.pre.split('.')
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
		const one = leftParts[index]
		const other = rightParts[index]
		if (one === undefined) return -1
		if (other === undefined) return 1
		const oneNumeric = /^\d+$/u.test(one)
		const otherNumeric = /^\d+$/u.test(other)
		if (oneNumeric && otherNumeric) {
			const difference = Number(one) - Number(other)
			if (difference !== 0) return difference
			continue
		}
		// Numeric identifiers always have lower precedence than alphanumeric ones.
		if (oneNumeric !== otherNumeric) return oneNumeric ? -1 : 1
		if (one !== other) return one < other ? -1 : 1
	}
	return 0
}

/**
 * What is wrong with the local `dsh`, or null when nothing is.
 *
 * The message is written to be the whole answer: what was found, what is required, and
 * the one command that fixes it. A reader who has just seen a credential error has no
 * reason to suspect the version, so the sentence has to make the connection for them.
 *
 * @param reported - the version found, or null when none could be read.
 * @param output - what the probe printed, quoted back when there was no version in it.
 * @returns the problem, or null.
 */
function versionProblem(reported, output = '') {
	if (reported === null) {
		const said = String(output ?? '').replace(/\s+/gu, ' ').trim()
		return (
			`the local tab needs \`dsh\` on PATH, and running \`dsh --version\` produced no version` +
			(said === '' ? '' : ` — it said: ${said.slice(0, 200)}`) +
			`. Install it with: npm install -g @deepseek-ai/dsh@latest`
		)
	}
	if (compareVersions(reported, MINIMUM_VERSION) < 0) {
		return (
			`the local tab needs \`dsh\` ${MINIMUM_VERSION} or newer, and PATH has ${reported}. ` +
			'An older one cannot read the credential store, so it asks for DEEPSEEK_API_KEY in the ' +
			'environment and fails the first turn with a message about credentials — which is why this ' +
			'is checked before the launch rather than diagnosed afterwards. ' +
			'Update it with: npm install -g @deepseek-ai/dsh@latest'
		)
	}
	return null
}

/**
 * Ask the local `dsh` what version it is.
 *
 * @param platform - the local platform.
 * @returns the version and the raw output, or the error.
 */
function probeLocalDsh(platform = process.platform) {
	return new Promise((resolve) => {
		const argv = versionArgv(platform)
		const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
		let out = ''
		let done = false
		const finish = (value) => {
			if (done) return
			done = true
			clearTimeout(timer)
			resolve(value)
		}
		const timer = setTimeout(() => {
			try {
				child.kill()
			} catch {
				/* already gone */
			}
			finish({ version: null, output: '' })
		}, VERSION_TIMEOUT_MS)
		child.stdout?.setEncoding('utf8')
		child.stderr?.setEncoding('utf8')
		child.stdout?.on('data', (chunk) => {
			out += chunk
		})
		child.stderr?.on('data', (chunk) => {
			out += chunk
		})
		child.once('error', () => {
			finish({ version: null, output: out })
		})
		child.once('exit', () => {
			finish({ version: parseVersion(out), output: out })
		})
	})
}

module.exports = {
	MINIMUM_VERSION,
	VERSION_TIMEOUT_MS,
	windowsCommandShell,
	versionArgv,
	parseVersion,
	compareVersions,
	versionProblem,
	probeLocalDsh
}
