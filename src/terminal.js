'use strict'

const remote = require('./remote.js')

/**
 * Interactive ssh terminals, for the shell a device's operator would get by
 * typing `ssh` themselves.
 *
 * The transport is a **local pseudo-terminal**, not a pair of pipes. A shell is
 * an interactive program: it asks the terminal how wide it is, it puts the line
 * discipline in raw mode, and it expects a window change when the window is
 * resized. A pipe has none of those answers, so an `ssh` on pipes gives a shell
 * that wraps at 80 columns for ever, and the first full-screen program is the
 * moment the operator finds out. The pty is also what lets ssh put the far side's
 * terminal in raw mode at all — without one it refuses to allocate a remote pty
 * unless it is forced, and forcing it leaves the size unchangeable.
 *
 * `node-pty` is the only native dependency in this application, and it is loaded
 * lazily so everything else — the offline suites, the device book, the Harness
 * tabs — still runs on a machine where the binary cannot be loaded. The failure
 * is then one terminal tab that says so, instead of an application that does not
 * start.
 *
 * This module has no Electron dependency, like `connect.js`: `tools/terminal.mjs`
 * drives it directly, and the window is not needed to know what it runs.
 */

/** The columns a session starts with, until the window has measured itself. */
const DEFAULT_COLS = 100

/** The rows a session starts with, for the same reason. */
const DEFAULT_ROWS = 30

/**
 * How much output is held for a terminal the renderer has not attached to yet.
 *
 * The window between "ssh was spawned" and "xterm exists" is a couple of IPC round
 * trips, but a failing ssh prints its reason in that window, and a reason nobody
 * can read is the least useful part of a failure. Half a megabyte is far more than
 * that conversation needs; the cap is only there so a tab that is never looked at
 * cannot grow without bound.
 */
const MAX_PENDING = 512 * 1024

/**
 * The widest and tallest a session may be told it is.
 *
 * These are not display limits — they are what keeps a renderer bug, or a crafted
 * IPC message, from asking a pty for a window that is larger than any screen and
 * making the far side lay out a million cells.
 */
const MAX_COLS = 512
const MAX_ROWS = 512

/**
 * The PowerShell program that starts the operator's shell on a Windows device.
 *
 * **This is passed with `-EncodedCommand` rather than as text, and the reason is
 * the three shells between here and the prompt.** ssh joins its argv with spaces
 * and hands the result to the far side's default shell; on Windows that may be
 * cmd.exe, Windows PowerShell or PowerShell 7, and each parses quotes and
 * `&`/`>`/`|` differently. The repository already paid for this lesson in
 * `remote.windowsCommand`: base64 of UTF-16LE survives ssh's join, cmd's parsing
 * and PowerShell's own, because it contains no character any of them acts on.
 *
 * The outer PowerShell is Windows PowerShell 5.1, which every supported Windows
 * has. It picks `pwsh` when the operator has PowerShell 7 and falls back to
 * `powershell` when they do not, then runs it **interactively** — no
 * `-NonInteractive`, no `-NoExit`: when the operator types `exit` the whole
 * session ends, rather than dropping them back into a prompt they did not ask for.
 * The profile is loaded by the inner shell (`-NoLogo` only), because a terminal
 * that skips the operator's profile is not their terminal. The *outer* one gets
 * `-NoProfile`, since its only job is the selection and its profile would be a
 * second, invisible prompt startup on every connect.
 *
 * The alternative — `where pwsh >nul 2>nul && pwsh -NoLogo || powershell -NoLogo`
 * — was rejected because cmd's `||` also fires when pwsh exits with a non-zero
 * code, so typing `exit 1` in PowerShell 7 would start Windows PowerShell
 * underneath it.
 *
 * @returns the PowerShell program.
 */
function windowsShellScript() {
	return [
		'$shell = Get-Command pwsh -CommandType Application -ErrorAction SilentlyContinue',
		'if ($null -ne $shell) { & $shell.Source -NoLogo } else { & powershell -NoLogo }'
	].join('; ')
}

/**
 * The remote command that opens an interactive shell on one shell family.
 *
 * POSIX is deliberately **undefined**: with no command ssh starts the account's
 * login shell, which is the literal thing the operator would have got. Naming a
 * shell there would pick bash on a machine whose user runs zsh, and skip the
 * login profile that puts their tools on PATH.
 *
 * @param platform - `posix` or `windows`.
 * @returns the command argument, or undefined to accept the login shell.
 */
function terminalCommand(platform) {
	if (platform === 'posix') return undefined
	if (platform === 'windows') {
		const encoded = Buffer.from(windowsShellScript(), 'utf16le').toString('base64')
		return `powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
	}
	throw new Error(`cannot open a terminal for the shell family "${String(platform)}"`)
}

/**
 * The complete argv that opens a terminal on a device.
 *
 * `-tt` is not redundant with the local pty. It tells ssh to allocate a pty on
 * the **far side** even though this side's pty is enough for ssh's own line
 * discipline — without it, a command-carrying session (the Windows one) gets no
 * remote pty, and powershell decides it is not talking to a terminal.
 *
 * @param device - the device record.
 * @param platform - `posix` or `windows`.
 * @param ssh - the ssh executable.
 * @returns the argv.
 */
function terminalArgv(device, platform, ssh = 'ssh') {
	const target = `${device.user}@${device.host}`
	const command = terminalCommand(platform)
	return [ssh, '-tt', ...remote.sshOptions(device), target, ...(command === undefined ? [] : [command])]
}

/**
 * Clamp a requested column count to something a pty can be asked for.
 * @param value - the requested columns.
 * @returns a whole number in range.
 */
function clampCols(value) {
	const number = Math.trunc(Number(value))
	if (!Number.isFinite(number) || number < 2) return 2
	return Math.min(number, MAX_COLS)
}

/**
 * Clamp a requested row count to something a pty can be asked for.
 * @param value - the requested rows.
 * @returns a whole number in range.
 */
function clampRows(value) {
	const number = Math.trunc(Number(value))
	if (!Number.isFinite(number) || number < 1) return 1
	return Math.min(number, MAX_ROWS)
}

/** The lazily loaded native binding, so a missing binary breaks one tab only. */
let ptyModule

/**
 * Spawn a process on a pseudo-terminal, loading `node-pty` on first use.
 * @param file - the executable.
 * @param args - its argv.
 * @param options - node-pty's options.
 * @returns the pty handle.
 */
function spawnPty(file, args, options) {
	if (ptyModule === undefined) {
		try {
			ptyModule = require('node-pty')
		} catch (error) {
			throw new Error(
				`the terminal needs its node-pty native module, which could not be loaded: ${error instanceof Error ? error.message : String(error)}`
			)
		}
	}
	return ptyModule.spawn(file, args, options)
}

/**
 * Start one interactive session.
 *
 * The returned session buffers the far side's first words until the renderer has
 * attached an xterm to it. That is not an optimisation: the tab becomes `running`
 * in the same turn the process is spawned, but the renderer still has to receive
 * the state push, create the terminal and send `attach` back — and a failed ssh
 * prints everything it has to say well inside that window.
 *
 * @param options - `device`, `platform`, `ssh`, `cols`, `rows`, `env`, `cwd`,
 *   `onData`, `onExit`, and `spawn` for a test harness.
 * @returns the session.
 */
function start(options = {}) {
	if (options.device === undefined) throw new Error('terminal.start needs a device')
	const argv = terminalArgv(options.device, options.platform, options.ssh ?? 'ssh')
	const cols = clampCols(options.cols ?? DEFAULT_COLS)
	const rows = clampRows(options.rows ?? DEFAULT_ROWS)
	const onData = typeof options.onData === 'function' ? options.onData : () => {}
	const onExit = typeof options.onExit === 'function' ? options.onExit : () => {}
	const spawn = typeof options.spawn === 'function' ? options.spawn : spawnPty
	const pty = spawn(argv[0], argv.slice(1), {
		name: 'xterm-256color',
		cols,
		rows,
		// The local environment is what ssh reads to decide what to send the far
		// side, and a GUI-launched process has no TERM at all. Naming the terminal
		// here is what makes a POSIX remote's `ls --color`, `vim` and prompt pick
		// their xterm paths instead of their dumb-terminal ones.
		env: { ...process.env, ...(options.env ?? {}), TERM: 'xterm-256color' },
		cwd: options.cwd ?? process.cwd()
	})

	/** The far side's output while no renderer is listening. */
	const pending = []
	let pendingChars = 0
	let attached = false
	let ended = false
	/** Whether `kill` has already run, so a close and a restart cannot kill twice. */
	let killed = false
	/** @type {{exitCode: number|undefined, signal: number|undefined}|undefined} */
	let exitInfo

	/**
	 * Hold one chunk until there is somewhere to draw it.
	 * @param data - the chunk.
	 */
	const hold = (data) => {
		pending.push(data)
		pendingChars += data.length
		while (pendingChars > MAX_PENDING && pending.length > 1) {
			const dropped = pending.shift()
			pendingChars -= dropped.length
		}
		if (pendingChars > MAX_PENDING) {
			pending[0] = pending[0].slice(-MAX_PENDING)
			pendingChars = MAX_PENDING
		}
	}

	pty.onData((data) => {
		if (attached) onData(data)
		else hold(data)
	})
	pty.onExit((event) => {
		ended = true
		exitInfo = { exitCode: event.exitCode, signal: event.signal }
		onExit(exitInfo)
	})

	return {
		pid: pty.pid,
		/**
		 * Hand the buffered output to the renderer, once.
		 */
		attach() {
			if (attached) return
			attached = true
			const held = pending.splice(0, pending.length)
			pendingChars = 0
			for (const data of held) onData(data)
		},
		/**
		 * Type into the session.
		 * @param data - the bytes the terminal produced.
		 */
		write(data) {
			if (ended) return
			const text = typeof data === 'string' ? data : String(data ?? '')
			if (text === '') return
			try {
				pty.write(text)
			} catch {
				/* the process can end between the check and the write */
			}
		},
		/**
		 * Tell the session how large its window is.
		 * @param nextCols - columns.
		 * @param nextRows - rows.
		 */
		resize(nextCols, nextRows) {
			if (ended) return
			try {
				pty.resize(clampCols(nextCols), clampRows(nextRows))
			} catch {
				/* a pty that is already gone */
			}
		},
		/** End the session and the ssh client with it. */
		kill() {
			if (ended || killed) return
			killed = true
			try {
				pty.kill()
			} catch {
				/* already gone */
			}
		},
		/** Whether the ssh client is still alive. */
		stillRunning() {
			return !ended
		},
		/** Whether the renderer has taken the buffered output. */
		isAttached() {
			return attached
		},
		/** How the session ended, once it has. */
		exitStatus() {
			return exitInfo
		}
	}
}

module.exports = {
	DEFAULT_COLS,
	DEFAULT_ROWS,
	MAX_COLS,
	MAX_ROWS,
	MAX_PENDING,
	windowsShellScript,
	terminalCommand,
	terminalArgv,
	clampCols,
	clampRows,
	start
}