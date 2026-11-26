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
 * A readiness line in the exact shape `dsh web --no-open --port 0` prints, captured
 * from a real run on this machine — with the session token replaced by a placeholder
 * of the same length.
 *
 * The token is a credential for as long as its server lives: the first request trades
 * it for a session cookie. This file is published, and a second client reads it, so
 * the value in it is not one. What has to be faithful is the line, not the secret —
 * and it is the whole line rather than just the URL, because the prefix is part of
 * what a client has to match: the URL alone does not satisfy `remote.readyUrl()`,
 * which is the sort of thing worth finding out here rather than in a Kotlin port.
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

/**
 * Capture the persistent-host builders, for both directory variants.
 *
 * The ensure program depends on the directory exactly as `remoteProgram` does —
 * the Harness starts in it — so a second client must reproduce the same variant
 * split. The stop program never enters a directory and is captured once.
 * @param platform - the shell family.
 * @returns the two variants and the stop program.
 */
function persistentPrograms(platform) {
	const withDirectory = platform === 'windows' ? 'C:\\work\\dsh' : '~/work/dsh'
	const variant = (directory) => {
		const recorded = directory === undefined ? device() : device(directory)
		const program = remote.persistentEnsureProgram(recorded, platform)
		return {
			...(directory === undefined ? {} : { directory }),
			program,
			remoteCommand: remote.remoteCommand(program, platform)
		}
	}
	return {
		withoutDirectory: variant(undefined),
		withDirectory: variant(withDirectory),
		stop: remote.persistentStopProgram(device(), platform)
	}
}

const contract = {
	__generated: `${TOOL} — do not edit by hand; run \`node ${TOOL}\``,
	contractVersion: CONTRACT_VERSION,
	protocol: 'dsh web over ssh',	source: {
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
		// Derived rather than written twice: the two copies were identical by hand, and
		// the Kotlin parity test asserts that they agree — which is a test for a
		// mistake this line can simply not make.
		exampleUrl: READY_EXAMPLE.replace(/^dsh web:\s*/u, ''),
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
		jschEquivalent: 'channel.getOutputStream().close() → Channel.eof() → SSH_MSG_CHANNEL_EOF',
		// **The contract has a second half: a launch that outlived its own client.**
		// Closing stdin only fires when the connection *ends*. Measured on a real
		// Windows remote on 2026-11-25: a Harness started by the tablet's earlier
		// connection was still serving four minutes after the same tablet had
		// reconnected, still holding the Sessions' write leases — and DSH gives a
		// Session one writer, so the new window could not open them at all
		// (`session/writer-held`, the UI's "当前会话已被占用…"). A client must
		// therefore be able to name what it started and reap it on the next launch.
		staleLaunch: {
			windowsRecord: '%LOCALAPPDATA%\\dsh-tabs\\remote-harness.json',
			fields: ['sup', 'pid', 'started', 'node', 'binJs', 'cwd'],
			reapBeforeStart: true,
			identityCheck: 'a pid is killed only while it is still a powershell.exe running -EncodedCommand, or a node.exe carrying this launcher\'s argv',
			cleanedBy: 'the launch that wrote it, in its own teardown',
			posix: 'not recorded: the POSIX branch reads stdin through `cat > /dev/null` and was measured to reap on disconnect, and a Windows-only gap must not change the other branch',
			why: 'two Harnesses over one DSH home cannot share Session write leases, so "one" and "none" are the only useful states'
		}
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
	},

	/**
	 * The persistent-host protocol: the second way a far side may be started.
	 *
	 * The whole point is that **no part of the ssh session owns the Harness**. The
	 * ordinary launch above dies with the connection by design; this one outlives
	 * it, records itself, and is adopted by the next connection instead of being
	 * started twice. Two Harnesses over one DSH home cannot share Session write
	 * leases, so adoption is a correctness requirement, not a convenience.
	 *
	 * A second client must implement both programs, not just the launch: without
	 * `stop` there is no way to give a leased Session back, and without the adopt
	 * branch two clients produce the `session/writer-held` failure this exists to
	 * prevent.
	 */
	persistent: {
		record: {
			// Inside the far side's DSH home, so "one host per home" and the Session
			// write lease are stated in the same coordinate system.
			directory: remote.HOST_DIR,
			file: remote.HOST_RECORD_FILE,
			log: remote.HOST_LOG_FILE,
			windowsLauncher: remote.HOST_LAUNCHER_FILE,
			version: remote.HOST_RECORD_VERSION,
			home: '`DSH_HOME` when set, otherwise `~/.dsh` (POSIX) / `%USERPROFILE%\\.dsh` (Windows)',
			fields: ['version', 'pid', 'port', 'token', 'started'],
			// The record holds a launch token, which is a credential: it trades for a
			// browser cookie. Treat it as one.
			permissions: 'POSIX `chmod 600`; Windows inherits the DSH home ACL',
			// Values are numeric, base64url and ISO, so a reader needs no JSON parser:
			// the POSIX branch reads them with four `sed` expressions.
			valuesAreJsonSafe: true
		},

		// The two lines a client has to parse. The readiness line comes **last**, and
		// is byte-identical to the ordinary launch's, so an existing reader is reused
		// rather than a second syntax invented.
		output: {
			adopted: 'HOST adopted pid=<n> port=<n> token=<t> started=<iso>',
			started: 'HOST started pid=<n> port=<n> token=<t> started=<iso>',
			stopped: 'HOST stopped pid=<n>',
			none: 'HOST none',
			stale: 'HOST stale <reason>',
			error: 'HOST error <text>',
			readiness: 'dsh web: <url> — the existing readiness line, printed after the HOST line'
		},

		// Adoption identity is three independent facts, because a pid is recycled and
		// a port can belong to something else: the pid is alive, `ps`/CIM says it is
		// still a Harness, and the recorded port accepts a connection.
		identity: {
			pid: 'alive (`kill -0` / `Get-CimInstance Win32_Process`)',
			commandLine: 'contains ` web `',
			port: 'accepts a loopback connection',
			not: 'a timestamp is not evidence, and neither is the record alone'
		},

		// One ensure at a time per home. Two connections that both see "no host"
		// would otherwise both start one.
		lock: {
			path: `${remote.HOST_DIR}/ensure.lock`,
			acquire: 'POSIX `mkdir`; Windows `New-Item -ItemType Directory`',
			waitMs: remote.HOST_LOCK_WAIT_MS,
			staleAfterMs: 120_000,
			release: 'the ensure program removes it, including on failure (`trap … EXIT` / `finally`)'
		},

		budgets: {
			startTimeoutMs: remote.HOST_START_TIMEOUT_MS,
			lockWaitMs: remote.HOST_LOCK_WAIT_MS
		},

		// Why the two platforms start the process differently. Both are measured
		// decisions; neither is a style choice.
		launch: {
			posix: '`nohup dsh web --no-open --port 0 </dev/null >>log 2>&1 &` — `nohup` execs, so `$!` is the Harness pid',
			posixWhy: '`setsid` forks when its caller leads a process group, so the pid it leaves is not reliably the Harness',
			windows: 'a generated `.cmd` created by `Invoke-CimMethod Win32_Process Create`',
			windowsWhy: 'the created process has a `WmiPrvSE.exe` parent, so the ssh session has no handle to it; a `Start-Process` inside the session does',
			windowsQuoting: 'a `.cmd` file, because `cmd /c ""set "X=…" && …""` is parsed wrong and reports `\'"set "PROBE_INLINE\' is not recognized`'
		},

		ensure: {
			posix: persistentPrograms('posix'),
			windows: persistentPrograms('windows')
		}
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
