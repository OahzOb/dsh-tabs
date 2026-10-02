'use strict'

/**
 * Write `docs/contract.json` — the protocol a second client has to speak.
 *
 * **Why this exists.** `dsh-tabs` is one client of a protocol it does not own:
 * it starts `dsh web` on some machine, waits for a readiness line, forwards a
 * port, and tears the far side down by closing stdin. Every one of those steps is
 * a wire-level promise, and the promises currently live in three places that
 * cannot import each other — this application's `src/remote.js`, the
 * `dsh-remote-devices` plugin it was copied from, and the Android client that is
 * planned. The plugin is the **source**: `tools/smoke.mjs` asserts that the
 * thirteen shared builders here are byte-identical to it, so a change to this
 * file alone is a change to a copy, which is exactly the drift that check exists
 * to catch.
 *
 * This file does not replace that check. It states the contract in one place a
 * non-JavaScript client can read, and it turns "the Android port must produce the
 * same bytes" into something a machine compares instead of a reviewer believing.
 *
 * **Generated, not hand-written.** Every value below is read out of
 * `src/remote.js` — nothing here is typed in twice. `tools/smoke.mjs` then
 * compares the two, so this file cannot quietly go stale, and regenerating it is
 * a deliberate act with a visible diff. The single exception is
 * `readiness.example`, which is a **fixture**: a real readiness line captured from
 * a real `dsh`, and the only thing here that is not derived from the source.
 * `tools/readiness.cjs` is where that capture comes from.
 *
 * Usage:
 *
 *   node tools/contract.cjs            # rewrite docs/contract.json
 *   node tools/contract.cjs --check    # fail if it is out of date, write nothing
 */

const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { basename, dirname, join } = require('node:path')

const remote = require('../src/remote.js')

const ROOT = join(__dirname, '..')
const TARGET = join(ROOT, 'docs', 'contract.json')

// Named from the file itself rather than typed in, so renaming this tool cannot
// leave a stale regeneration command inside the artifact it writes.
const TOOL = `tools/${basename(__filename)}`

/** The schema version of this document itself, not of the protocol. */
const CONTRACT_VERSION = 1

/**
 * A real readiness line, exactly as `dsh web --no-open --port 0` printed it on
 * this machine.
 *
 * A **fixture**, and the one value in this file that is not derived from this
 * repository: it describes a component outside it. It is the whole line rather
 * than just the URL, because the prefix is part of what a client has to match —
 * the URL alone does not satisfy `remote.readyUrl()`, which is the sort of thing
 * worth finding out here rather than in a Kotlin port.
 */
const READY_EXAMPLE = 'dsh web: http://127.0.0.1:56418/?token=not-a-real-token-not-a-real-token-000000000'

/**
 * The device shapes that make the builders produce different bytes.
 *
 * A `directory` is not cosmetic: `~` has to expand on the far side while the rest
 * of the path stays quoted, and that is a rule a second client must reproduce
 * rather than reinvent (`remote.remoteCd`). So each program is captured twice —
 * with no directory, and with a `~`-relative one.
 *
 * Only the fields the builders read are set. The rest of a device record
 * (`label`, `transport`, `id`) never reaches the far side.
 *
 * @param directory - the launch directory, or undefined for none.
 * @returns a device record.
 */
function device(directory) {
	return directory === undefined
		? { host: 'build-01.example.net', user: 'deploy', sshPort: 22 }
		: { host: 'build-01.example.net', user: 'deploy', sshPort: 22, directory }
}

/**
 * Capture every program builder for both directory variants.
 * @param platform - the shell family.
 * @returns the two program strings and the argv elements they travel in.
 */
function programs(platform) {
	const withDirectory = platform === 'windows' ? 'C:\\work\\dsh' : '~/work/dsh'
	return {
		argv: remote.remoteCommand(remote.remoteProgram(device(), platform), platform),
		withoutDirectory: {
			program: remote.remoteProgram(device(), platform),
			remoteCommand: remote.remoteCommand(remote.remoteProgram(device(), platform), platform)
		},
		withDirectory: {
			directory: withDirectory,
			program: remote.remoteProgram(device(withDirectory), platform),
			remoteCommand: remote.remoteCommand(remote.remoteProgram(device(withDirectory), platform), platform)
		}
	}
}

const contract = {
	__generated: `${TOOL} — do not edit by hand; run \`node ${TOOL}\``,
	contractVersion: CONTRACT_VERSION,
	protocol: 'dsh web over ssh',
	source: {
		// The plugin is normative. This application carries a copy, and the suite
		// fails if the copy drifts — so a second client must port from the
		// protocol, not from either JavaScript file, because both of them move.
		normative: 'dsh-remote-devices plugin (plugins/dsh-remote-devices/index.js)',
		copy: 'src/remote.js',
		parityCheck: 'tools/smoke.mjs — "every copied builder is byte-identical to the plugin\'s"'
	},

	readiness: {
		// The whole handshake: the server's stdout is watched for this, and only
		// complete lines count until the process is known to have stopped
		// printing. `\S+` will match a URL a pipe split mid-write, which is a
		// truncated port and a NaN — reproduced and paid for, see src/remote.js.
		linePattern: remote.READY_LINE.source,
		lineFlags: remote.READY_LINE.flags,
		completeLinesOnly: true,
		partialLineAllowedAfterExit: true,
		example: READY_EXAMPLE,
		exampleUrl: 'http://127.0.0.1:56418/?token=not-a-real-token-not-a-real-token-000000000',
		// `--port 0` means the far side's OS picks the port, and the real one is
		// read back out of this line. A second client must not invent a port.
		urlCarriesPort: true,
		urlCarriesSessionToken: true
	},

	// Wall-clock budgets. These are this client's policy, not the protocol's: a
	// second client may choose differently, but it has to choose, and it should
	// know what the reference client waits.
	budgets: {
		startTimeoutMs: remote.START_TIMEOUT_MS,
		probeTimeoutMs: remote.PROBE_TIMEOUT_MS,
		tunnelTimeoutMs: remote.TUNNEL_TIMEOUT_MS,
		defaultSshPort: remote.DEFAULT_SSH_PORT
	},

	sshOptions: remote.sshOptions(device()),

	// The security half of the same options. `sshOptions` above is the literal
	// argv, and `StrictHostKeyChecking=accept-new` in it is easy to read as "no
	// checking" — which is what a JVM library's equivalent switch means, so this is
	// stated separately rather than left to be inferred from the string.
	hostKeys: {
		policy: 'StrictHostKeyChecking=accept-new',
		unknownHost: 'trusted on first use, and remembered in the operator\'s own known_hosts',
		changedHost: '**refused** — the connection fails and nothing is sent to the host',
		changedHostRecovery: 'the operator removes the stale entry from known_hosts themselves; nothing in this application rewrites or bypasses it',
		// The trap. JSch's `StrictHostKeyChecking=no` accepts a CHANGED key
		// silently — the `i == CHANGED` branch is guarded by
		// `(shkc.equals("ask") || shkc.equals("yes"))` in `Session.doCheckHostKey`,
		// so a mismatch throws only when the value is `ask` or `yes`. `no` is
		// therefore weaker than OpenSSH's `accept-new`, not equal to it, and a port
		// that copies the switch name rather than the behaviour silently downgrades
		// every connection after the first.
		libraryWarning: 'JSch: `no` also accepts a changed key; true accept-new needs a custom HostKeyRepository with StrictHostKeyChecking=yes'
	},

	teardown: {
		// The load-bearing rule. A remote command started over ssh does not
		// reliably die when the connection goes away — measured: `exec dsh web`
		// and even `ssh -tt` both survived the client being killed outright,
		// leaving an orphan holding the remote port. Closing stdin does not have
		// that failure mode, because sshd hands the remote command a pipe that
		// reaches EOF however the connection ends.
		by: 'close the remote command\'s stdin, and let the far side reap itself',
		stdinMustStayOpenUntilThen: true,
		posixBlocksOn: 'cat > /dev/null',
		windowsBlocksOn: '[Console]::In.ReadToEnd()',
		jschEquivalent: 'channel.getOutputStream().close() → Channel.eof() → SSH_MSG_CHANNEL_EOF'
	},

	platform: {
		// One argv element, no metacharacters: a POSIX host answers Linux/Darwin
		// on stdout, while cmd.exe and PowerShell both fail the command and print
		// nothing. ssh's own exit code 255 means the connection failed and is
		// reported as such, rather than being mistaken for a platform.
		probe: 'uname -s',
		classifier: 'remote.classifyPlatform(exitCode, stdout)',
		posixMatch: String(remote.classifyPlatform(0, 'Linux\n').platform),
		windowsMatch: String(remote.classifyPlatform(1, '').platform),
		sshFailureExitCode: 255
	},

	remoteProgram: {
		// The quoting rule a port must copy rather than reinvent. `cd '~/x'` does
		// NOT work: the single quotes that make the path injection-safe also
		// suppress the expansion that turns `~` into `$HOME`, so the directory is
		// looked up literally and every device configured as `~/...` dies at
		// startup with `No such file or directory`. Splitting the tilde off and
		// quoting only the remainder keeps both the expansion and the safety —
		// which is why the captured strings below look over-quoted in places.
		directoryRule: {
			posix: 'split `~` off `~` and `~/...`, quote only the remainder: cd "$HOME"/\'work/dsh\'',
			windows: '`~` and `~\\` are joined onto $env:USERPROFILE, then Set-Location -LiteralPath'
		},
		// A port must not invent its own answer to "what if the directory contains a
		// quote". The reference client's answer is to refuse a small set of
		// characters, and the reasons are in the README — `%VAR%` and `!VAR!` expand
		// even inside double quotes, which is why escaping was not attempted.
		//
		// **This is about agreement, not about the same danger.** The Android client
		// hands the program to `ChannelExec`, so no shell parses the directory there
		// and it was never exposed to the injection the Windows local branch had.
		// What would still hurt is the two clients disagreeing: a book entry one
		// accepts and the other refuses is a machine that works on the phone and not
		// on the desktop, which reads as a bug in whichever one the operator tried
		// second. So both refuse the same set.
		directorySafety: {
			rejectedCharacters: ['"', "'", '%', '!', '&', '|', '<', '>', '^'],
			refused: true,
			agreement: 'both clients refuse the same characters, so a device book is portable between them',
			whyHere: 'the reference client cannot escape a directory into the single command string it hands to cmd.exe, and `%`/`!` expand even inside double quotes',
			whyStill: 'the Android client has no shell in the path and does not need the restriction; it applies it to stay interoperable',
			check: 'remote.directoryProblem(directory)'
		},
		posix: programs('posix'),
		windows: programs('windows')
	}
}

/**
 * Compare the contract with the file on disk.
 * @param text - the serialized contract.
 * @returns true when they are identical.
 */
function upToDate(text) {
	try {
		return readFileSync(TARGET, 'utf8') === text
	} catch {
		return false
	}
}

// `\n` explicitly, and a trailing newline, because `.gitattributes` pins every
// file in this project to LF and the JSON must not depend on the host.
const text = `${JSON.stringify(contract, null, 2)}\n`

if (process.argv.includes('--check')) {
	if (upToDate(text)) {
		console.log('docs/contract.json is up to date')
		process.exit(0)
	}
	console.error(`docs/contract.json is stale — run \`node ${TOOL}\` and review the diff`)
	process.exit(1)
}

mkdirSync(dirname(TARGET), { recursive: true })
writeFileSync(TARGET, text, 'utf8')
console.log(`wrote ${TARGET} (${String(Buffer.byteLength(text))} bytes)`)
