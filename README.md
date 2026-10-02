# dsh-tabs

A tabbed host for DSH web interfaces. One window, an always-visible tab bar, and
one tab per Harness: the local one, plus one per remote machine reached over an
SSH tunnel.

## Why this is not a plugin

The same feature exists as a Desktop plugin (`plugins/dsh-remote-devices`), and
it works. It also hits a ceiling that no amount of plugin code can lift, because
of where an embedded surface is allowed to live:

| Wanted | Plugin | Reason |
| --- | --- | --- |
| A tab bar that stays visible | no | It has to live inside the surface it switches, so it disappears with it |
| Tabs in the window chrome | no | That row is Electron's native menu; the one window-chrome seat is taken and macOS-only |
| `Alt+1…9` while focus is inside a remote interface | no | Key events do not cross into a `<webview>` guest, and the shell's shortcut registry **replaces** the whole definition list |
| A local tab that is a peer of the remote ones | no | The plugin is a guest of the local Harness, not its host |

Owning the window removes all four. In particular, `before-input-event` fires in
the main process for every web contents — guest included — before the key is
delivered anywhere, so the same handler covers focus in this app's chrome and
focus deep inside a remote interface.

## Running it

```
npm install          # installs the electron wrapper
npm run install-electron   # downloads the ~150 MB binary (Electron 44 has no postinstall)
npm start
```

### The Electron version is pinned, conservatively

The dependency is exact — `"electron": "44.0.0"` — which is what the Harness
desktop application on this machine runs (`Electron/44.0.0`,
`Chrome/152.0.7977.54`, read out of its own binary) and is therefore known to work
here.

**The evidence for the pin is weaker than it first looked, and that is worth
saying.** A later patch release, `44.5.1`, was observed producing a real APPCRASH
(`0xC0000005` inside `electron.exe`), while `44.0.0` produced a silent
`STATUS_BREAKPOINT`. That comparison was made *before* the directory turned out to
be the cause — both runs were from inside `$DSH_HOME`, where **every** Electron
fails — so the difference between the two versions may have been nothing more than
how the same underlying failure happened to manifest. Bumping the pin is probably
safe; it has simply not been measured from a location where Electron is known to
start.

Whatever version is installed, the first thing to run when the window does not
appear is the binary on its own — it bypasses npm and prints an exit code:

```powershell
.\node_modules\electron\dist\electron.exe --version ; $LASTEXITCODE
```

A version string means the binary is fine and the problem is in the application.
Silence plus `-2147483645` means it did not start at all — check the directory
above first, then `Get-WinEvent -LogName Application` for an APPCRASH naming
`electron.exe`.

> **Clear `ELECTRON_RUN_AS_NODE` before believing either answer.** With that
> variable set, `electron.exe` is a Node interpreter: `--version` prints the Node
> version bundled inside Electron, so a **healthy** binary answers `v24.18.1`
> where this document promises `v44.0.0`, and a broken one answers nothing. The
> string is not a version of Electron, and a wrong-looking version is far more
> likely to send you hunting a broken download than a silent exit is.
>
> The variable is set per-process by whatever launched the shell, not at User or
> Machine scope, which is why it is invisible to any check except this one:
>
> ```powershell
> $env:ELECTRON_RUN_AS_NODE = $null                                   # clear it for the child
> (Get-Item .\node_modules\electron\dist\electron.exe).VersionInfo.ProductVersion
> ```
>
> The second line reads `44.0.0` out of the file itself and cannot be affected by
> the environment at all, which makes it the better primary check.
>
> The same variable silently costs you `npm start`, and that failure is worse
> than a wrong version number: Electron runs `src/main.js` as a plain Node script,
> `require('electron')` returns the path to the binary instead of the API, and the
> run dies with `TypeError: Cannot read properties of undefined (reading 'on')` at
> the first `app.on(...)` — a message that names a line of this application and
> not the variable. `main.js` now detects that state at the top of the file and
> exits with the diagnosis and the fix instead.

On a network where the GitHub release CDN is unreachable, point the download at a
mirror:

```powershell
$env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"
npm run install-electron
```

If the install fails with `EPERM ... mkdtemp` under `%LOCALAPPDATA%\Temp`, give
the installer a writable temporary directory instead — `@electron/get` creates
its staging directory through `fs.mkdtemp`, which some environments refuse
outside the workspace:

```powershell
$env:TEMP = "$PWD\.tmp"; $env:TMP = $env:TEMP
npm run install-electron
```

## Using it

- **Tabs** are the local Harness and every device in the book. A tab is a
  *configured thing*, not a transient view: selecting an idle one starts it, and
  the `×` **disconnects** it rather than removing it. Removing a device is the
  `+` popover's job.
- **`Alt+1…9`** selects a tab, from anywhere, including while you are typing
  inside a remote interface.
- **`+`** lists the devices, adds one, and removes one.

## Devices

The book lives at `$DSH_HOME/dsh-tabs.json` and uses the same schema as the
plugin's. It is a **separate file on purpose**: two processes writing one JSON
file would clobber each other, and this app must not corrupt a book the Desktop
plugin is still using. On first run the plugin's `remote-devices.json` is copied
over, so devices configured there are waiting here.

Each device is `{label, host, user, sshPort, directory?}`. A Windows host needs
nothing extra — the shell family is detected.

### Every write goes through one door

`src/devices.js` exposes `mutate(change)` and everything that edits the book uses
it: adding, removing, and the detected shell family. Nothing calls `load()` and
then `save()` in sequence any more.

That is not tidiness. **`load()` followed by `save()` is a lost update** whenever
anything else can write in between — the second writer's copy is the one that
survives and the first one's changes are gone. This book had two writers that
overlap in practice: every tab activation persists a detected platform, and the
`+` popover edits the same file. Measured on this project, that combination could
**resurrect a device that had just been removed**, or **silently drop an edit that
had just been saved** — and it did so often enough that the suite driving both
paths failed about one run in three.

The schema being shared with the plugin is what made that a real risk rather than
a theoretical one, and the fix has a matching limit worth stating plainly:
`mutate` serializes the writers **inside this process**. The separate file is what
keeps the plugin's process out, and that is the whole reason the file is separate.

### One field is placed inside a shell, so one field is restricted

`directory` is the only value in the book that is not merely *passed* to a program
but **written into a shell program as text** — in four different branches, and they
do not agree on how to quote it:

| Branch | How it is embedded | Safe? |
| --- | --- | --- |
| POSIX remote / local | `shellSingleQuote` — single quotes, embedded quotes doubled | yes, by construction |
| Windows **remote** | `windowsLiteral` inside the script sent as `-EncodedCommand` | yes, by construction |
| Windows **local** | `cd /d "<directory>" && dsh web …` handed to `cmd /c` | **no** — and it is the only one |

`cmd /c` takes a single command *string*, and `cd /d` needs its path in double
quotes, so a directory containing `"` closed the quote and everything after it
became a new command:

```
directory   ~/work" & calc.exe & "
cmd /c      cd /d "~/work" & calc.exe & "" && dsh web --no-open --port 0
```

**That is fixed by refusing the value, not by escaping it.** `%VAR%` and delayed
`!VAR!` expand even *inside* double quotes, so a path that looks safely quoted can
still be rewritten before `cd` ever sees it, and cmd's rules differ between its
command line and a batch file. Reproducing all of that correctly for a field that
normally holds something like `C:\work` is not worth the complexity. So
`remote.directoryProblem()` rejects `"` `'` `%` `!` `&` `|` `<` `>` `^`, and
everything else is quoted normally. POSIX is deliberately **not** restricted: a
single-quoted POSIX string has no metacharacters at all, so `~/work; rm -rf /` is
just an odd directory name there.

Two things worth knowing about it:

- **The value is checked twice** — when the popover saves it, so a typo is reported
  while the operator is still looking at the field, and again in `connectLocal`,
  because the book is a JSON file that can also be edited by hand.
- **The injection was latent, not live.** `activate()` never passed a directory to
  the local tab, so the unescaped concatenation was not reachable through the UI.
  It is fixed anyway: the parameter exists for exactly that purpose, and the next
  change to use it would have made it live.

### What the remote needs

A **Node-installed `dsh`**, not the packaged Desktop application. The Desktop
ships its Harness inside `app.asar` and installs no `dsh` command, so a machine
with only the Desktop installed cannot serve as a remote. The local tab has the
same requirement for the same reason, and it uses whatever `dsh` is on this
machine's PATH.

> If the local tab looks older than the Desktop application you are used to, that
> is why: this machine's global CLI is a different install from the Harness
> bundled inside the Desktop app. Update it with
> `npm install -g @deepseek-ai/dsh@latest`.

A Windows remote additionally needs an SSH server, which Windows does not enable
by default. In an **administrator** PowerShell there:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server' -Enabled True `
  -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

Authorize the key. A **non-administrator** account reads
`%USERPROFILE%\.ssh\authorized_keys`; an **administrator** account reads
`%ProgramData%\ssh\administrators_authorized_keys` instead, and that file's ACL
must be restricted to SYSTEM and Administrators or sshd ignores it.

## How a connect works

Two ssh connections per device, deliberately:

1. **The server.** `dsh web --no-open --port 0` runs on the far side, so the
   remote's OS picks a free port and a connect can never collide with a server
   someone started by hand. The real port is read back from the readiness line.
2. **The tunnel.** A bare `ssh -N -L` forward to the port the first one
   announced.

The teardown is the load-bearing part. A remote command started over ssh does
**not** reliably die when the connection goes away — measured on this project, a
plain `exec dsh web` and even one under `ssh -tt` both survived the client being
killed outright, leaving an orphaned server holding the remote port. So the
server is backgrounded and the remote shell blocks on stdin instead: sshd hands
it a pipe that reaches EOF the moment the connection ends, however it ends, and
the server is always reaped. That is why the ssh client is always given a stdin
pipe that is never written to and never closed early, and why `stopTab` closes
that pipe *before* killing anything.

## Windows remotes

There is no `bash -lic` to ask for, so a Windows host gets a PowerShell program
instead. The shell family is detected, not configured: `uname -s` is sent as a
single argv element with no metacharacters, so a POSIX host answers `Linux` or
`Darwin` on stdout while cmd.exe and PowerShell both fail the command and print
nothing. Only ssh's own exit code 255 means the connection failed, and that is
reported straight through — an unreachable host fails **once**, with the ssh
error, instead of twice under a platform guess.

> **This path works, and it is worth saying so precisely, because the same
> construction fails for the local tab.** The Windows program starts the server
> with `Start-Process -NoNewWindow`, and that is exactly what broke the Windows
> *local* tab — there, PowerShell is spawned with pipes by this application and the
> server gets no usable stdout. Over ssh the same script is spawned by sshd
> instead, and **measured against a real Windows host it works**: the far side is
> classified `windows`, the readiness line arrives, the tunnel comes up and the
> interface loads.
>
> What is different is the handle setup the parent hands PowerShell — a console
> versus a set of pipes — and that has not been pinned down further. The point of
> recording it is that the two cases must not be "made symmetric" again: the local
> tab was changed to match this program, and it stopped launching entirely.

The Windows program keeps both halves of the POSIX contract: the server's stdout
is **inherited** so the readiness line streams down the channel with no temp
file, and `[Console]::In.ReadToEnd()` blocks until stdin reaches EOF. The script
is passed with `-EncodedCommand` (base64 UTF-16LE), which is the only quoting
strategy that survives ssh joining its argv, the remote's `cmd.exe`, and a script
full of characters cmd would otherwise eat.

## Layout

```
src/main.js        the window, the tabs, the tunnels, the shortcuts
src/preload.js     the renderer's entire view of the main process
src/remote.js      what to run on the far side — a copy, see below
src/devices.js     the device book
src/renderer/      the tab bar and the guest host
tools/smoke.mjs    offline checks
```

`src/remote.js` is a **copy** of the pure builders in the `dsh-remote-devices`
plugin. A standalone application cannot import from a plugin directory the
operator may delete, so the logic is duplicated rather than shared — and
`tools/smoke.mjs` asserts that every copied function is still byte-identical to
the original. Drift fails the suite instead of surfacing later as a mysterious
connect failure.

### Keep it out of `$DSH_HOME`

**This is the failure that cost the most time, and the cause is the directory, not
the code.** Electron cannot start from anywhere under the Harness home directory
on the machine this was built against. Measured with the same 73-file
distribution copied to five places — identical bytes, verified file counts:

| Location | `electron.exe --version` |
| --- | --- |
| `<home>\.dsh\apps\dsh-tabs\node_modules\electron\dist` | no output, exit `-2147483645` |
| `<home>\.dsh\apps\dsh-tabs\inside-dsh-dist` | no output, exit `-2147483645` |
| `<home>\.dsh\electron-probe3\dist` | no output, exit `-2147483645` |
| `<home>\dsh-probe3\dist` | `v44.0.0`, exit 0 |
| `C:\dsh-electron-test` | `v44.0.0`, exit 0 |

It is the exact directory name, not the shape of the path: `.dshX`, `.dsh2` and
`.x` under the same parent all work, `C:\Users\…\.dsh` does not, and `.dsh` is a
plain NTFS directory on the same volume with no reparse point. `node.exe` runs
fine from inside `.dsh` — it is specific to Electron.

`-2147483645` is `0x80000003`, `STATUS_BREAKPOINT`, which is what Chromium's
`BreakDebugger()` terminates with when no debugger is attached: a fatal check
before anything can be logged. So the symptom is a silent no-op — `npm start`
prints its banner and returns to the prompt with no error at all.

The mechanism is **not** known. What is ruled out, each by measurement: it is not
the code signature (the same failure reproduces with a signed Electron), not Smart
App Control (turning it off and rebooting changes nothing, and the machine's
code-integrity log has no entry naming Electron), not the process that launched it
(a WMI-created process outside the launcher's job object behaves identically), not
the file name (renaming changes nothing), not `PATH` (a system-only `PATH`
changes nothing), not a corrupt download (the zip's SHA-256 matches Electron's own
`checksums.json`) and not an incomplete extraction (73 files, all present).

**So: put this application anywhere outside `$DSH_HOME`.** It lives at
`C:\Projects\dsh-tabs` for exactly that reason. Nothing about it depends on the
location.

## The local tab needs a current `dsh`, not a credential of its own

**This section replaced a wrong diagnosis, so it is worth reading as a warning
about the class of bug rather than the instance.**

The symptom was a failed first turn in the local tab:

```
llm-deepseek: no API route for provider route "deepseek-official";
store DEEPSEEK_API_KEY through the credentials service (the web Models page
writes it), or export DEEPSEEK_API_KEY in the launching environment
MISSING_CREDENTIAL
```

The message says a shell-launched Harness needs `DEEPSEEK_API_KEY` in its
environment, and that reading was taken at face value: the conclusion recorded
here was that only the desktop shell can reach the encrypted store in
`$DSH_HOME/.credentials.yaml` and hand the key over, so a second local Harness
could never have it.

**That was wrong, and one timestamp disproves it.** The credential store had not
been written for two days, and the environment still had no `DEEPSEEK_API_KEY` —
yet the local tab started working. The only thing that changed in between was the
global CLI: it was `0.1.7-rc.2` and was upgraded to `0.2.0-rc.2`, the same version
the desktop application bundles. **`dsh` reads the credential store itself; the
version on `PATH` simply has to be recent enough to do it.** The old one falls
back to the message above, which tells you to export the variable because that is
the only route *it* has.

So there is nothing to configure — and there *was* a dependency this application did
not check, which it now does:

> **The local tab runs whatever `dsh` is on `PATH`, and its version is load-bearing.**
> Two releases behind is enough to break it, with an error that points at credentials
> rather than at the version.

`src/localdsh.js` runs `dsh --version` before the local tab launches anything, and
refuses with the version it found, the version it needs, and the command that fixes it.
Two things about it are worth knowing:

- **The floor is the version this application was measured against**, `0.2.0-rc.2`, not
  the oldest one that might work. `0.1.7-rc.2` is known to break; one release behind has
  not been measured either way, and a floor set optimistically is a floor that reports
  nothing while the operator gets the credential error anyway.
- **It does not make a broken install work — it makes it say so.** An old `dsh` used to
  hang until the 45-second readiness timeout and *then* report a credential error, which
  is the least actionable pair this application can produce. The check answers in about a
  tenth of a second and names the thing to change.

The POSIX probe asks for an interactive login shell (`bash -lic`), the same one the
Harness itself is started with, because an nvm install puts its bin directory on `PATH`
from `~/.bashrc` — a probe without `-i` would report "not found" for a machine where the
launch works.

The three remedies the message suggests (store it from the Models page, export it, or
run no second local Harness) remain valid, but none of them was the actual fix, and none
of them is needed on a current install.

## Known limitation: a force-killed application leaks its Harness

Closing the window is clean — verified: the application quits, the tree kill in
`connect.js` runs, and the local Harness disappears with it. That is the path an
operator actually takes.

**Terminating the process outright still leaks it.** Nothing inside the child can
prevent that: the application is the one that knows the process tree, and a
terminated application runs no code.

### How the Windows local tab is started, and why it is not symmetric

The local tab used to be wrapped in the same PowerShell program as a Windows
remote, so that it would inherit the same `stdin`-EOF teardown. **That was wrong,
and it broke the local tab entirely** — the symptom was `the Harness never
announced a URL within 45s`. Measured against the same `dsh`:

| launch | result |
| --- | --- |
| `cmd /c "dsh web --no-open --port 0"` | readiness line in **1.5 s** (re-measured 2026-10: 1.4 / 1.4 / 1.5 / 1.7 s over four runs) |
| `powershell -Command "dsh web …"` | exit 1 |
| the `Start-Process -NoNewWindow` wrapper | **no output at all for 30 s** |

The repeat was not idle: a first attempt at re-measuring this read **23.7 s**, which
against a 45 s budget would have made the timeout a live risk. It was a measurement
artefact — `Start-Process -RedirectStandardOutput` plus a polling loop — and the
same four runs under `tools/readiness.cjs`, which spawns what the application
actually spawns, came back at the original figure. The number above is the one to
trust because the probe and the application share a launch path; a hand-rolled
`cmd /c` in a terminal shares neither the stdio shape nor the process tree.

`Start-Process -NoNewWindow` does not give the server a usable stdout when
PowerShell was itself spawned with pipes, which is how this application spawns it.
So Windows uses `cmd /c`, which means **the Windows local tab has no `stdin`
contract** — POSIX still does — and what reaps it is the tree kill instead:

```js
spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
```

Two details there are load-bearing and were each paid for by a leak:

- **`/T`** — an npm global install puts a `.cmd` shim between the shell and the
  Harness, so the tree is `cmd.exe → dsh.cmd → node` and killing one leaves two.
- **`spawnSync`, not `spawn`** — an asynchronous `taskkill` is a child of the
  application, and this runs during `before-quit`: the application exits and takes
  it along before it has done anything. Blocking the quit for the tens of
  milliseconds it takes is the entire point.

A leaked Harness is a stray process holding a loopback port, not a corrupted
state: the next launch starts a fresh one on a fresh port.

### A third detail, found by accident: the kill has a window

**`stopLocal` closes stdin before it runs the tree kill, and that ordering opens a
window in which the tree walk finds nothing.** `taskkill /T` walks children of the
pid it is given; if the shell has already exited — which is exactly what closing
stdin is asking it to do — there is no child list left to walk, and the Harness
underneath it survives holding its port.

This was found from the outside: a probing run of `tools/readiness.cjs` left a
Harness **listening on `127.0.0.1:55747`** minutes after the run that created it had
reported success. The other runs in that batch were reaped normally, so the window
is narrow rather than wide, and the probe has since been reordered to kill the
tree *before* closing stdin — after which five consecutive runs reaped cleanly,
with the probe checking for new listeners after every one.

No run in those five was reaped by EOF: every one reported `taskkill /T /F`, which
is independent confirmation that the Windows local tab has no `stdin` contract to
fall back on.

That reordering is **not** applied to `stopLocal` here. Doing it gives up the only
measurement of whether the command's own `stdin` contract did anything, and on
POSIX — where the contract is the one that works — the ordering is deliberate.
`readiness.cjs` reaping in the safe order and reporting which case it saw
(`stopped by exit on EOF` versus `taskkill /T /F`) is the evidence that would
justify changing the application.

## Android: a sibling client, not a port of this one

**The Android client exists and is in use.** It lives in a sibling repository,
`../dsh-tabs-android`, and it was built from the two studies below after they decided
what it should be. The studies are kept here because their conclusion is not history:
it is a decision about what may be shared between the two clients, and that decision
constrains what either repository is allowed to grow into.

The studies are a pair, and they were researched separately:

| Study | The question it answers |
| --- | --- |
| [android-ssh-feasibility.md](docs/android-ssh-feasibility.md) | Embed Node, port to Kotlin, or vendor an `ssh` binary — and which JVM SSH library |
| [android-webview-proxy-feasibility.md](docs/android-webview-proxy-feasibility.md) | What the `WebView` does with the resulting `http://127.0.0.1:<port>` URL |

### The decision worth recording: the Node code is not shared

The obvious plan — embed a Node runtime in the APK and reuse `src/remote.js` —
**cannot work, and it fails totally rather than partially**: `nodejs-mobile`, the
only real candidate, does not implement `child_process` at all, and
`src/connect.js` is *defined* by it — spawn `ssh`, parse the readiness line, spawn
a second `ssh -N -L` for the tunnel. The same runtime's last release was
2024-10-07 on Node 18, which reached end-of-life on 2025-04-30.

So the Android client is a **native Kotlin client with an in-process SSH
session** — `com.github.mwiede:jsch` plus BouncyCastle — and it shares **no
source** with this application. What it shares is the **protocol**: the readiness
line, the remote program, the platform split, and the teardown-by-EOF contract.

That protocol has two artefacts, and they play different roles:

| Artefact | Role |
| --- | --- |
| [contract.json](docs/contract.json) | The protocol, stated in one place a non-JavaScript client can read — the readiness pattern, the budgets, the ssh options, and the exact bytes of every remote program. Generated by `node tools/contract.cjs` from `src/remote.js`, so it cannot drift from the code. |
| `src/remote.js` | This repository's **copy** of the builders. |

> **`src/remote.js` is the copy, not the original.** The original is the
> `dsh-remote-devices` Desktop plugin, and `test:smoke` asserts the thirteen shared
> builders here are byte-identical to it. A port that copies `src/remote.js`
> therefore copies a copy — and when the plugin moves, the copy follows it and the
> suite re-pins both, which is the only thing keeping them honest. The contract is
> the stable artefact to port *from*; neither JavaScript file is.

### The three rules a port gets wrong by default

The contract carries them, and they are worth reading before writing Kotlin rather
than after, because each is a case where the *obvious* implementation is the
insecure one:

| Rule | Where it lives | The trap |
| --- | --- | --- |
| A **changed** host key is refused, not accepted | `hostKeys` | JSch's `StrictHostKeyChecking=no` also accepts a changed key — the `i == CHANGED` branch only throws for `ask`/`yes`. Copying the switch name from `sshOptions` downgrades every connection after the first. |
| A launch directory can contain shell metacharacters and must be quoted **or refused** | `remoteProgram.directoryRule`, `directorySafety` | Only the Windows local branch is unsafe, and it is unsafe because `cmd /c` takes one command string. POSIX is fine unquoted-looking; a port that "simplifies" the quoting breaks `~/...` paths. |
| Teardown is **closing stdin**, not killing the process | `teardown` | Killing the client leaves the far side's server running and holding its port — measured, and the reason the remote program blocks on `cat > /dev/null`. |

The contract is also the reason these can be checked at all: a Kotlin client can
read `docs/contract.json` in a test and compare its own builders against the
reference bytes, which is the same property `test:smoke` enforces between this
repository's copy and the plugin.

Both artefacts answer one question — *what must a second client produce?* — and
`tools/readiness.cjs` is how the part of that question living outside this
repository stays honest:

```
node tools/readiness.cjs        # start a real local dsh web, time it, stop it
```

Run five times on this machine it produced **1.5 / 1.6 / 1.6 / 1.6 / 1.7 s** against
a 45 s budget, every run with the readiness line in the shape `READY_LINE` parses
and no run leaking a process. That is `npm test`'s one deliberate blind spot: the
suites are offline, and a `dsh` that changed its output format would break the
local tab, every remote tab, the Desktop plugin and the Android client at once
without any offline check noticing.

> **The library caveat that will bite first.** JSch's
> `StrictHostKeyChecking=no` accepts a **changed** host key silently, so it is
> weaker than the `accept-new` this application passes to `ssh`
> (`src/remote.js:sshOptions`, and `sshOptions` in the contract). Reproducing this
> client's actual behaviour needs a custom `HostKeyRepository` — roughly 40 lines
> — and no default JSch configuration provides it.

### What the studies do not claim, and what the client has since settled

Neither study was tested on a device or an emulator: every library claim in them comes
from published source, documentation, or artifact inspection, and both carry an
explicit list of what could not be verified. The items that decided the port were on
that list — the BouncyCastle provider collision on Android, the `minSdk` floor for
Ed25519, and whether a `specialUse` foreground service survives Play review — and the
first was expected to be settled by a spike before any application code.

**It was, and worse than the study feared.** JSch ships its Ed25519 implementation
under `META-INF/versions/15/` in a multi-release JAR, and Android's runtime does not
implement those: it links the base class, whose constructor throws
`UnsupportedOperationException("SignatureEd25519 requires Java15+")`. BouncyCastle is
therefore the only route JSch has, and it has to be *registered* at start-up or the
handshake fails with the library sitting unused on the classpath. That, and the rest
of what the client measured on real hardware, is in `../dsh-tabs-android`'s README —
which is the record now, not these studies.

The studies also rule out more than they choose: vendoring an `ssh` binary is legal
but needs a Node fork anyway, Termux is excluded by requiring the user to install
Termux, and no pure-JS SSH client avoids the Node built-ins that a WebView-resident
runtime cannot provide.

### The Windows remote: what the watchdog does not cover

The Windows branch reports a child that dies before announcing a URL — but **only
after the child has been launched.** A failure before that line, such as
`Set-Location` refusing a directory that does not exist, exits the program with the
watchdog never reached. Measured against `box-b`: the far side printed

```
Set-Location : Cannot find path 'C:\definitely-not-a-directory-dsh-tabs' because it does not exist.
```

and exited in **2.9 s**, while the client waited out its full **45-second** readiness
timeout.

**What that cost has since been paid off, without touching the watchdog.** The remote
had already said what was wrong; the client was throwing it away. `awaitReady` now
keeps the stderr it was only transcribing and quotes it in the failure, so the same
connect reports within 2.9 seconds:

```
the remote command exited with code 1 before announcing a URL —
it said: Set-Location : Cannot find path 'C:\…' because it does not exist.
```

Getting that sentence out is its own small problem, because PowerShell serialises its
error stream as **CLIXML** when stderr is redirected: the far side's 1131 bytes were
one `<Objs …>` document in which the useful line sat inside an `<S S="Error">` record
with its newlines escaped. `connect.js` decodes it and keeps the **first** error record
— the sentence that names the fault; the records after it are the source excerpt and
`CategoryInfo`, which are for whoever edits the script rather than whoever is trying to
connect.

What remains, and why it is not fixed: the watchdog would have to run *concurrently*
with blocking on stdin rather than before it, because those are the two things the
program does and blocking is its whole teardown contract. That is a change in shape to
a program now verified end to end against a real Windows host, and the operator no
longer has to guess — they get the reason either way. The watchdog's own message also
prints an empty exit code, because `Start-Process -PassThru` leaves `$proc.ExitCode`
unset without `-Wait`, and `WaitForExit()` and `Refresh()` do not fill it in either
(PowerShell 5.1).

## Test

```
npm test                              # every offline suite
npm run test:live                     # against a real device, no window
npm run test:live -- <device-id>      # pick one from the book
npm run contract -- --check           # fail if docs/contract.json is stale
npm run readiness                     # start a real local dsh web, time it, stop it
```

`npm test` runs four suites, each aimed at a layer that can be exercised without a
window:

| Suite | What it drives | Why it exists |
| --- | --- | --- |
| `test:smoke` | the source, the builders' output, and this document | drift, platform rules, byte-parity with the plugin, the protocol contract, and the runbook's own claims |
| `test:connect` | `src/connect.js` | port allocation, the readiness reader, tunnel probing |
| `test:main` | `src/main.js` against a stubbed Electron | the tab lifecycle and **the `Alt+digit` routing** |
| `test:renderer` | `src/renderer/app.js` in jsdom | the tab bar, guest reuse, panels, and the IPC calls it makes |

`test:smoke` also reads **this document**. Four of its checks exist because each
names a defect that no amount of source inspection would have caught: the
`electron.exe --version` recipe in *Running it* has to stay paired with the
`ELECTRON_RUN_AS_NODE` warning beside it, every `DSH_*` variable named here has to
be one a source file actually reads — the table at the end of this section once
named a variable by a spelling no file contained — no heading may be left standing
over nothing at all, and **every local link has to resolve**, which is the only
thing watching the paths to the studies above: no source file names them, so a
moved or renamed one is a dead end nothing else would notice.

Two tools are deliberately outside `npm test`, because the suites are offline and
these are not:

| Tool | What it does |
| --- | --- |
| `tools/contract.cjs` | Regenerates `docs/contract.json` from `src/remote.js`. `test:smoke` fails if the file is stale, so the regeneration is a deliberate act with a reviewable diff. |
| `tools/readiness.cjs` | Starts a real local `dsh web`, checks the readiness line still arrives in the shape `READY_LINE` parses, times it against the 45 s budget, and reaps it. This is the blind spot the offline suites cannot cover. |

Both are CommonJS (`.cjs`) rather than ESM (`.mjs`) like the suites: they `require`
`src/remote.js`, which is CommonJS, and `.mjs` cannot `require`.

jsdom is not Chromium, so `test:renderer` does not prove the window looks right.
What it proves is the reconciliation logic — one guest per (tab, url), correct
hiding, correct panels, correct calls — which is where the bugs were: it caught a
popover marker that was true for every device, and `test:connect` caught a
readiness line that resolved with a truncated URL when the pipe split it.

`test:live` drives `src/connect.js` against a real device end to end: platform
detection, the readiness line, the tunnel binding, the token → cookie exchange,
the Harness document, the unauthenticated fence, the unary RPC carrier, and the
teardown leaving no orphan on the far side. It reads the device book and never
writes to it.

`test:main` is why the shortcut lives in the main process rather than the page:
key events do not cross into a `<webview>` guest, so a renderer-side listener
would only ever see focus in the app's own chrome. The suite presses keys through
`before-input-event` and checks which tab wins.

Two environment variables make the suites work from a directory that is not
inside `$DSH_HOME`, which is where this application has to live:

| Variable | Why |
| --- | --- |
| `DSH_REMOTE_DEVICES_PLUGIN` | The path to the plugin's `index.js`, for the parity check. Without it a few plausible locations are tried, and if none matches the check reports **SKIP** rather than passing quietly — losing it means losing the only thing that notices the copy drifting. |
| `DSH_TABS_TEST_HOME` | Where `test:main` puts its scratch device book. The suite creates a directory, and some environments refuse that outside their own workspace. Unset, it tries `<repo>\.tmp-main-test` and then the system temp directory, and prints which one it used. |

> **Never run these files directly against a real `$DSH_HOME`.** `test:main`
> overwrites the device book it is pointed at — that is how it arranges each
> test's world — so `node tools/main.mjs` from a shell that already exports
> `DSH_HOME` to the real home puts test fixtures in place of the operator's
> devices. That happened while this suite was being written, and it emptied a book
> holding two real devices; they survived only because the plugin's
> `remote-devices.json` still had them and this application seeds from it.
>
> Both suites now defend themselves. `test:main` ignores a `DSH_HOME` that is
> `$DSH_HOME` or the home directory itself and falls back to
> `DSH_TABS_TEST_HOME`, saying so; it redirects rather than refusing, because
> refusing would break `npm test` in exactly those shells. `test:smoke` moves
> itself to a scratch directory for the same reason, since it only needs a book to
> write and throw away.
