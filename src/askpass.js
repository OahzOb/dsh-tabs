'use strict'

/**
 * The password half of an ssh connection.
 *
 * `ssh` has no option that takes a password, on purpose — it reads one from the
 * terminal, and a GUI has no terminal to read from. What it does have is
 * `SSH_ASKPASS`: when ssh needs a secret and cannot ask a terminal, it runs that
 * program and reads the first line of its stdout as the answer. So the password
 * reaches ssh the way ssh is designed to be given one, and never through argv.
 *
 * **Measured on this machine, because the Windows port was the open question**
 * (OpenSSH_for_Windows_9.5p2):
 *
 * - `SSH_ASKPASS_REQUIRE=force` makes ssh use the helper even with a console and
 *   even with stdin redirected, so a GUI child process is the ordinary case rather
 *   than an edge one;
 * - `DISPLAY` is not needed when `force` is set — the helper ran with no `DISPLAY`
 *   in the environment at all;
 * - the helper may be a `.cmd` file, and its path may contain a space. Both were
 *   tried against a real sshd, and the helper ran both times.
 *
 * **Why the password is an environment variable and not an argument.** `sshpass -p`
 * and `plink -pw` put the secret in the process command line, where every other
 * process on the machine can read it from the process list. An environment
 * variable is readable by the same user's processes too — that is the same threat
 * model `sshpass -e` has, and no worse than the password being in this process's
 * memory — but it does not appear in `ps`, in a transcript, or in a crash dump's
 * command line. The variable exists only in the `ssh` child's environment and is
 * never written to the device book.
 *
 * **What the helper has to survive.** A password may contain `&`, `|`, `<`, `>`,
 * `^` and `%`, all of which cmd.exe would otherwise interpret, and may contain
 * non-ASCII characters, which Windows PowerShell would otherwise transcode through
 * the OEM code page. So the Windows helper never echoes the value through cmd: it
 * hands the whole job to PowerShell, which reads the variable as a string and
 * writes its UTF-8 bytes to the raw stdout handle. The POSIX helper is the same
 * idea with `printf`, and is chmod 700 because it is the one file that says how to
 * reach the secret.
 */

const { chmodSync, existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

/** The environment variable the helper reads the password from. */
const PASSWORD_VARIABLE = 'DSH_SSH_PASSWORD'

/** The variable that makes ssh ask the helper instead of a terminal. */
const REQUIRE_VARIABLE = 'SSH_ASKPASS_REQUIRE'

/** The helper's file name on each shell family. */
const HELPER_NAME = { win32: 'askpass.cmd', posix: 'askpass.sh' }

/**
 * The full path of the helper in one directory.
 *
 * @param directory - where the helper lives.
 * @param platform - the platform it is being written for.
 * @returns the path.
 */
function helperPath(directory, platform = process.platform) {
	return join(directory, HELPER_NAME[platform === 'win32' ? 'win32' : 'posix'])
}

/**
 * The helper's text.
 *
 * The Windows file is CRLF because cmd.exe is the one program that still cares,
 * and every line is there for a reason:
 *
 * - the `powershell` call is by absolute path, because ssh starts the helper
 *   itself and a PATH that has been trimmed for a GUI launch may not contain it;
 * - `[char]10` is the newline without an inner quote, so the whole `-Command`
 *   argument needs no escaped quotes inside the `.cmd`;
 * - `OpenStandardOutput()` bypasses PowerShell's console encoding, which would
 *   otherwise write a non-ASCII password in the machine's OEM code page and hand
 *   ssh a different string from the one the operator typed.
 *
 * @param platform - which shell family the helper is for.
 * @returns the file's contents.
 */
function helperScript(platform = process.platform) {
	if (platform === 'win32') {
		return [
			'@echo off',
			'rem Answers ssh\'s password prompt. Written by dsh-tabs; do not edit by hand.',
			'rem The password is in DSH_SSH_PASSWORD and is never written into this file.',
			'"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -Command "$b=[Text.Encoding]::UTF8.GetBytes($env:DSH_SSH_PASSWORD+[char]10);[Console]::OpenStandardOutput().Write($b,0,$b.Length)"',
			''
		].join('\r\n')
	}
	return [
		'#!/bin/sh',
		'# Answers ssh\'s password prompt. Written by dsh-tabs; do not edit by hand.',
		'# The password is in DSH_SSH_PASSWORD and is never written into this file.',
		`printf '%s\\n' "$${PASSWORD_VARIABLE}"`,
		''
	].join('\n')
}

/** Helpers already written by this process, so a connect is not a file write. */
const installed = new Set()

/**
 * Write the helper, once per process.
 *
 * Idempotent on purpose: every ssh client a connect spawns needs the same file,
 * and a connect spawns two or three. The permission change is POSIX-only — the
 * file is executable, and its directory is the application's own user-data
 * directory, which is already user-private.
 *
 * @param directory - where the helper lives.
 * @param platform - the platform it is being written for.
 * @returns the helper's path.
 */
function ensureHelper(directory, platform = process.platform) {
	const file = helperPath(directory, platform)
	if (installed.has(file) && existsSync(file)) return file
	mkdirSync(directory, { recursive: true })
	writeFileSync(file, helperScript(platform), 'utf8')
	if (platform !== 'win32') chmodSync(file, 0o700)
	installed.add(file)
	return file
}

/**
 * The environment one password-authenticated ssh client needs.
 *
 * `DISPLAY` is set for the POSIX case: ssh older than 8.4 ignores
 * `SSH_ASKPASS_REQUIRE` and consults the helper only when it has no terminal and
 * `DISPLAY` is set. Naming a display costs nothing when the variable is understood
 * and is the whole difference when it is not.
 *
 * @param password - the secret the operator typed.
 * @param directory - where the helper lives.
 * @param platform - the platform the ssh client runs on.
 * @returns the variables to merge into the child's environment.
 */
function envFor(password, directory, platform = process.platform) {
	if (typeof password !== 'string' || password === '') {
		throw new Error('a password-authenticated connection needs a non-empty password')
	}
	return {
		[PASSWORD_VARIABLE]: password,
		SSH_ASKPASS: ensureHelper(directory, platform),
		[REQUIRE_VARIABLE]: 'force',
		DISPLAY: process.env.DISPLAY ?? ':0'
	}
}

/**
 * Whether ssh's own words describe a rejected login rather than a broken network.
 *
 * This decides whether a password should be forgotten and asked for again. Only
 * the client's `Permission denied` and the far side's `Auth fail` count: a host
 * key refusal, a timeout or a DNS failure must leave the password alone, or a
 * mistyped host would silently throw away a good one.
 *
 * @param message - what the connect or the terminal reported.
 * @returns true when the credential was refused.
 */
function isAuthFailure(message) {
	const text = String(message ?? '')
	return /permission denied/iu.test(text) || /auth fail/iu.test(text)
}

module.exports = {
	PASSWORD_VARIABLE,
	REQUIRE_VARIABLE,
	HELPER_NAME,
	helperPath,
	helperScript,
	ensureHelper,
	envFor,
	isAuthFailure
}
