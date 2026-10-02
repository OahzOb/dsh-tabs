# Android SSH remote-CLI feasibility study

**Question:** should an Android app that connects to remote machines over SSH, runs a Node-based CLI web
server there, and displays its web UI — **embed Node**, **port the ~400 lines to Kotlin**, or **vendor an
`ssh` binary**? And if it ports, which SSH library?

**Date of research:** 2026-10-01. All version numbers, dates and issue counts were read from the cited
sources on that date. Anything I could not confirm is listed explicitly in §5.

> **This document is a merge of two studies that were researched separately and disagreed with each
> other.** The architecture question (embed / port / vendor) and the library question (which JVM SSH client)
> were answered in different files, and the same Maven artifacts were given different byte counts in each.
> §7 records every measurement that was reconciled, with the numbers re-measured rather than chosen. The
> companion study — what the Android `WebView` does with the resulting loopback URL — is
> [android-webview-proxy-feasibility.md](android-webview-proxy-feasibility.md).

---

## 1. Recommendation

### 1.1 The architecture: **port the SSH logic to Kotlin. Do not embed Node. Do not vendor an `ssh` binary.**

This is not a close call, and the decisive reasons are not about effort — they are structural.

**The "embed Node to reuse `src/remote.js`" plan cannot work, and the reason is total, not partial.**
`nodejs-mobile` **does not implement `child_process` at all**. From the project's own API-differences page:

> "**Unsupported.** The `child_process` and `cluster` modules are not available. nodejs-mobile runs in a
> mobile application process, which is expected to be a single process in the mobile operating systems, so
> forking the nodejs-mobile process results in errors for most cases. iOS doesn't give permissions to spawn
> new processes in most cases, as well. These modules are not supported in nodejs-mobile for the reasons
> presented."
> — <https://nodejs-mobile.github.io/docs/api/differences>

`dsh-tabs`'s connection layer is *defined* by `child_process.spawn` — it spawns `ssh`, parses a readiness
line from the child's stdout, and spawns a second `ssh -N -L` for the tunnel. Every one of those steps
disappears. Embedding nodejs-mobile buys you **zero** reuse of `src/remote.js`/`src/connect.js`; you would
rewrite the same amount of logic, but now in a *harder* environment (a background Node thread inside an
Android app, bridged to Kotlin), while also inheriting an abandoned runtime and a vendored-binary problem.
It is strictly worse than porting.

The same page also removes `intl`, the V8 inspector/debugger, and `process.stdin`; and notes that
`process.exit()` terminates the whole Android app.

**The maintainer signal on nodejs-mobile is disqualifying on its own:**

- Latest release: **v18.20.4, published 2024-10-07** — no release in ~2 years.
- That release is built on **Node.js 18**, which reached **end-of-life on 2025-04-30** (verified against
  `nodejs/Release` `schedule.json`). As of today that is ~18 months of an unpatched JS runtime shipped
  inside a networked app.
- Unreleased work sits on branches `update22-9-0` (Node 22.9.0) and `release18-20-4+16kb-fix`, plus open
  issue **#148 "Android 16KB Alignment"** — i.e. the shipped binary is not 16 KB-page compliant, and
  Google Play **blocks updates without 16 KB support from 2027-02-01** for apps targeting Android 15+.
- Cross-compiling native addons is documented as supported **only from Linux/macOS development machines**,
  which is a poor fit for a Windows-hosted project.

### 1.2 A Kotlin SSH library needs no binary and no second process

Verified APIs:

| Library | Local port forwarding (the `ssh -L` equivalent) |
|---|---|
| sshj | `net.schmizz.sshj.connection.channel.direct.LocalPortForwarder` |
| Apache MINA SSHD | `TcpipForwarder.startLocalPortForwarding(SshdSocketAddress local, SshdSocketAddress remote)` |
| mwiede/jsch | `setPortForwardingL` |

With one of these, the design collapses to a **single in-process SSH session**: open a session channel, run
the remote CLI web server on it and read its stdout (directly, instead of parsing a child process's
readiness line), then start a `LocalPortForwarder` bound to `127.0.0.1:<ephemeral>` and point the WebView at
it. Both spawned processes vanish. **This deletes the "can an embedded Node spawn `ssh`?" question rather
than answering it** — there is no `execve`, no W^X question, no SELinux question, no bundled-ELF licensing
question, and no `extractNativeLibs` trap.

This is also what the mainstream Android SSH client does. **ConnectBot** — the canonical Android SSH client —
depends on `libs.sshlib` (its own pure-Java Trilead SSH2–derived library) and uses **no bundled `ssh`
binary** (<https://github.com/connectbot/connectbot>). Shipping a bundled `ssh` ELF is the unusual path on
Android, not the normal one.

### 1.3 So is vendoring an `ssh` binary possible at all? Yes — but it is the worst option

It is *technically* permitted (see §3.2), but it requires all of:

1. Embedding a JS/Node runtime that **has** `child_process` — which excludes nodejs-mobile, i.e. you would
   have to build and maintain your own Node-for-Android fork;
2. Cross-compiling OpenSSH or Dropbear against Android bionic (NDK) — a real, ongoing build-and-patch burden;
3. Shipping it as `lib*.so` in `jniLibs` **and** keeping `extractNativeLibs="true"` /
   `useLegacyPackaging = true`, forfeiting the smaller/faster uncompressed-native-lib packaging;
4. Accepting a runtime with no `/etc/passwd`, no `~/.ssh`, no `known_hosts`, no `TERM`, no `ssh_config` —
   every option must be passed explicitly on the command line;
5. Doing all of the above to reach feature parity with a ~600 KB–1 MB Java library that already works.

### 1.4 The library: **`com.github.mwiede:jsch`, plus BouncyCastle**

**Use `com.github.mwiede:jsch:2.28.7`, plus `org.bouncycastle:bcprov-jdk18on:1.84` for modern algorithms.**

1. **All three candidates can do the two things you actually need.** Local port forwarding *and*
   "close-stdin ⇒ SSH EOF" were verified in the source of all three (§3.2). The decision is therefore **not**
   about capability — it is about Android risk, dependency weight, and how exactly the teardown primitive
   maps.

2. **JSch is the only candidate with zero mandatory transitive dependencies.** Its POM declares no
   `<dependencies>` at all
   ([jsch-2.28.7.pom](https://repo1.maven.org/maven2/com/github/mwiede/jsch/2.28.7/jsch-2.28.7.pom)); the
   runtime JAR is **714,740 bytes**. MINA SSHD needs two artifacts (1,937,523 bytes total); sshj's released
   POM pulls BouncyCastle at `runtime` scope, adding ~10.2 MB of JARs.

3. **You must ship BouncyCastle anyway on Android, so JSch's "zero-dep" claim is about *choice*, not about
   avoiding BC.** Android's platform JCE does not provide Ed25519 signatures below API 33, and does not
   provide XDH/X25519 below API 33 ([Android `Signature`](https://developer.android.com/reference/java/security/Signature),
   [`KeyPairGenerator`](https://developer.android.com/reference/java/security/KeyPairGenerator),
   [`KeyAgreement`](https://developer.android.com/reference/javax/crypto/KeyAgreement)). Since modern
   OpenSSH servers default to `ssh-ed25519` host keys and `curve25519-sha256` KEX, a minSdk 26–29 app
   effectively needs BC. The advantage is that with JSch you can *decide* (e.g. ship RSA/ECDSA-only first,
   add BC later); with sshj, BC is unconditional.

4. **JSch's teardown primitive is exactly the existing model.** `channel.getOutputStream().close()` calls
   `Channel.eof()`, which puts `SSH_MSG_CHANNEL_EOF` on the wire — verified at `Channel.java:287–305` and
   `:463–483` in the published sources. That is precisely the "close stdin ⇒ remote server reaps itself"
   behaviour the Electron client relies on, and the reason the contract can be shared rather than
   re-invented.

5. **Dynamic local-port allocation is built in and returns the port**: `int setPortForwardingL(int lport,
   String host, int rport)` returns "an allocated local TCP port number", and with `lport == 0` the
   implementation does `new ServerSocket(0, 0, addr)` then reads back `ss.getLocalPort()`
   (`PortWatcher.java:71–86`). No manual port-probing race.

#### The main cost of choosing JSch — read this before committing

**JSch's `StrictHostKeyChecking=no` is *weaker* than OpenSSH's `accept-new`.** Verified in
`Session.doCheckHostKey` (`Session.java:1022–1123`):

- With `StrictHostKeyChecking=no`, an **unknown** key is inserted into the repository (TOFU) — good.
- But a **changed** key is *also accepted silently*: the `i == CHANGED` branch is guarded by
  `(shkc.equals("ask") || shkc.equals("yes"))` (`:1043`, `:1081`), so with `"no"` no exception is thrown.

So `"no"` is closer to OpenSSH's `StrictHostKeyChecking=no` than to `accept-new`. **To get true
accept-new-plus-pinning semantics you must implement a custom `HostKeyRepository`** (interface at
`HostKeyRepository.java`, constants `OK=0`, `NOT_INCLUDED=1`, `CHANGED=2`) that returns `OK` and inserts on
unknown hosts, returns `CHANGED` on mismatch, and keep `StrictHostKeyChecking=yes` so that mismatch throws
`JSchChangedHostKeyException`. This is ~40 lines and is the single most important thing to get right; §3.3
shows it.

#### Runner-up

**Apache MINA SSHD `2.20.0`** if the team values a cleaner structured-teardown API
(`ExplicitPortForwardingTracker` is `AutoCloseable`), async NIO, and a broader feature set — and can accept
the caveats. Its own documentation is explicit that Android is not a supported target:

> "The SSHD team has not checked the compatibility and usability of the libraries for the Android O/S.
> Furthermore, at present it is not a stated goal of this project to actively support it…"
> — [docs/android.md](https://github.com/apache/mina-sshd/blob/master/docs/android.md)

Two further MINA-specific traps verified in source, both of which will silently break the port-forwarding
half of the design:

- **Local forwarding is rejected by default on the client.** `BaseBuilder.DEFAULT_FORWARDING_FILTER =
  RejectAllForwardingFilter.INSTANCE` (`BaseBuilder.java:64`, applied at `:186–187`, `:292`), and
  `DefaultForwarder.localPortForwardingRequested` refuses to bind when `!filter.canListen(...)`
  (`DefaultForwarder.java:664–671`). You **must** call
  `client.setForwardingFilter(AcceptAllForwardingFilter.INSTANCE)`. The docs mention this for the server,
  but it applies to the client too ([docs/port-forwarding.md](https://github.com/apache/mina-sshd/blob/master/docs/port-forwarding.md)).
- **MINA SSHD needs `java.nio.file.Path`**, which on Android is **API 26+**
  ([`java.nio.file` package](https://developer.android.com/reference/java/nio/file/package-summary)). A
  minSdk 26 floor is fine, but there is no headroom below it.
- **On Android it uses `user.home` / `user.dir` system properties that Android does not set**, requiring
  explicit bootstrapping via `OsUtils.setAndroid`, `OsUtils.setCurrentWorkingDirectoryResolver`,
  `PathUtils.setUserHomeFolderResolver`. The Android security-provider hook is contributed but unverified by
  the maintainers: *"we do not know for sure if this works for all/part of the needed security requirements
  since the code was donated without any in-depth explanation other than that 'is works'."*

#### Not recommended for this workload

**`com.hierynomus:sshj:0.41.1`** — technically capable (local port forwarding, command channels,
keyboard-interactive, known_hosts read/write all confirmed), but the heaviest dependency footprint
(BC `bcprov` 8,919,063 B + `bcpkix` 1,165,716 B + `asn-one` + `slf4j`), it makes you bind the listening
`ServerSocket` yourself, and it makes no Android-support statement. Its built-in SSH-agent transport also
needs a **Java 16+ runtime**, which Android does not have. Choose it only if you specifically want its API
or its `OpenSSHKnownHosts` read/write model. Never use `com.jcraft:jsch` — abandoned since 2018.

### 1.5 Consequences for the existing Node test suite (the real cost of the port)

The jsdom-based headless test suite is the one genuine loss. It tests *behaviour over a `child_process`
boundary*; after the port that boundary is gone, so the tests cannot be reused as-is. Mitigation: the JVM
side is at least as testable — the SSH library can be pointed at an in-process Apache MINA SSHD **server**
(or a Testcontainers/OpenSSH fixture) and the same jsdom suite can be kept as an end-to-end test driven
against the Kotlin implementation's observable contract (readiness line + forwarded port). Budget for
rewriting the tests, not for porting them. This is the strongest argument *against* the port, and it still
does not outweigh embedding an EOL runtime that cannot spawn a process.

---

## 2. Comparison tables

### 2.1 Approaches

| Approach | Maintained? | Latest version / date | License | Can spawn `ssh`? | Local port forward? | Size cost | Kotlin interop | Verdict |
|---|---|---|---|---|---|---|---|---|
| **Kotlin port + JVM SSH library** | **Yes** | sshj 0.41.1 (2026-09-21); MINA sshd 2.20.0 (2026-09-28); mwiede/jsch 2.28.7 (2026-08-20) | Apache-2.0 / Revised BSD | **Not needed** | Yes, in-process | 600 KB–1.9 MB | Native | ✅ **Recommended** |
| `nodejs-mobile` | Barely — no release since 2024-10-07, Node 18 **EOL 2025-04-30** | v18.20.4 (2024-10-07) | Node.js MIT | **No — `child_process` absent** | Would need `ssh2` | ~11.3 MB per ABI (`libnode.so`) | Background thread + bridge | ❌ Fails the core requirement |
| `nodejs-mobile-react-native` | Same core; plugin pushed 2024-10-07 | 18.20.4 (2024-10-07), MIT | MIT | **No** | — | same as above | React Native only | ❌ |
| `LiquidCore` | **Abandoned** | 0.7.10 (**2020-06-21**); repo last pushed 2023-01-05 | MIT | No | — | — | JNI | ❌ |
| `J2V8` | Slow | Maven 6.2.1 (2021-08-10); arm64 metadata 6.3.0 (2025-11-13) | — | No (V8 only) | — | **32.7 MB (arm64-v8a AAR); 56.3 MB (fat AAR)** | JNI, decent API | ❌ V8 only, no Node stdlib, huge |
| `GraalJS` | **Yes** (pushed 2026-09-30) | oracle/graaljs, UPL-1.0 | UPL-1.0 | No | — | Very large (Truffle/Graal) | JVM | ❌ No Node stdlib; Android support historically gated |
| WebContainer in WebView | Yes (API 1.6.4, 2026-04-14) | 1.6.4 | MIT *package*, but **commercial licence required** | No (no raw TCP) | No | — | none | ❌ Cannot SSH; needs StackBlitz backend + COOP/COEP |
| Termux / Termux:API | Yes (pushed 2026-09-26) | — | MIT (termux-shared) | Yes, in Termux | Yes, in Termux | 0 in your APK | Intent-based | ❌ Requires user to install Termux — excluded by requirement |
| QuickJS (`Zipline`) | **Yes** | 1.28.0 (2026-09-29) | Apache-2.0 | No | — | 1.85 MB AAR | Excellent (Kotlin-first) | ❌ Kotlin/JS only, not a Node/CommonJS runtime |
| QuickJS (`wang.harlon.quickjs`) | **Yes** | wrapper-android 3.2.0 (2025-05-15) | — | No | — | 2.22 MB AAR | Java API | ❌ No Node stdlib, no sockets |
| Vendor `ssh` ELF in `jniLibs` | Depends on your fork | OpenSSH / Dropbear | BSD / MIT-style (permissive) | Yes (that's the point) | Yes | +2–6 MB per ABI *(estimate, not measured — §5)* | Must pipe stdio | ⚠️ Legal but heavy; needs a Node fork anyway |
| `com.jcraft:jsch` | **Abandoned** | 0.1.55 (**2018-11-26**) | Revised BSD | Not needed | `setPortForwardingL` | 276 KB | Native | ❌ Superseded by mwiede fork |

### 2.2 JVM SSH libraries

Sizes are measured JAR byte counts from Maven Central (downloaded and `Length`-checked), i.e. **pre-shrink**.
Bytecode = maximum class-file major version among classes **on the real classpath** (excluding
`META-INF/versions/`, which D8 ignores).

| | **Apache MINA SSHD** | **JSch (mwiede fork)** | **sshj** |
|---|---|---|---|
| Maven coordinates | `org.apache.sshd:sshd-core` (+ `sshd-common`) | `com.github.mwiede:jsch` | `com.hierynomus:sshj` |
| Current version | **2.20.0** (stable, 2026-09-28); `3.0.0-M6` is a prerelease milestone (same date) | **2.28.7** (2026-08-20) | **0.41.1** (2026-09-21) |
| Version source | [metadata](https://repo1.maven.org/maven2/org/apache/sshd/sshd-core/maven-metadata.xml) | [metadata](https://repo1.maven.org/maven2/com/github/mwiede/jsch/maven-metadata.xml) | [metadata](https://repo1.maven.org/maven2/com/hierynomus/sshj/maven-metadata.xml) |
| License | Apache-2.0 (repo `spdx_id`; POM headers) | **Revised BSD** (+ Revised BSD for JZlib, ISC for jBCrypt) | Apache-2.0 |
| License source | [POM](https://repo1.maven.org/maven2/org/apache/sshd/sshd-core/3.0.0-M6/sshd-core-3.0.0-M6.pom), [API](https://api.github.com/repos/apache/mina-sshd) | [POM `<licenses>`](https://repo1.maven.org/maven2/com/github/mwiede/jsch/2.28.7/jsch-2.28.7.pom) | [POM](https://repo1.maven.org/maven2/com/hierynomus/sshj/0.41.1/sshj-0.41.1.pom) |
| Min Java (runtime) | Java 8 (`java.sdk.version=8`, `maven.compiler.release=8`) | **Java 8** ("Which is the minimum Java version required? → Java 8") | **Java 8 or higher** |
| Build JDK needed | 24 (`minimalJavaBuildVersion=24`) — *build only, not consumer* | — | — |
| Mandatory transitive deps | none mandatory; `sshd-common` required. BC / `net.i2p.crypto:eddsa` / tomcat-apr are `optional` | **none** (POM has no `<dependencies>`) | **`slf4j-api` 2.0.17, `bcprov-jdk18on` 1.84, `bcpkix-jdk18on` 1.84, `asn-one` 0.6.0** — all `runtime` scope |
| JAR size (measured) | `sshd-core` 970,864 + `sshd-common` 966,659 = **1,937,523 B** (2.20.0) | **714,740 B** | `sshj` 599,970 B **+ BC/asn/slf4j ≈ 10,221,692 B ≈ 10.2 MB** |
| Bytecode on real classpath | **major 52 (Java 8)**, all classes | **major 52 (Java 8)** for 329 classes; 51 higher-version classes are all `META-INF/versions/` (multi-release JAR) | **major 52 (Java 8)**, 454 classes |
| Multi-release JAR? | Yes in 3.0.0-M6 (10 entries in `META-INF/versions/`); 2.20.0 is clean | **Yes** (JEP 238) — higher-Java features only load on newer JVMs | No |
| Java 8 desugaring needed? | **No** — bytecode is Java 8 | **No** | **No** |
| **Local port forwarding (`-L`)** | ✅ `createLocalPortForwardingTracker` | ✅ `setPortForwardingL` | ✅ `newLocalPortForwarder` |
| **OS-allocated local port** | ✅ "if zero one is allocated" | ✅ `lport=0`, returns allocated port | ⚠️ manual: bind `ServerSocket(0)` yourself |
| **Remote cmd + stdin held open** | ✅ `getInvertedIn()` (never close) | ✅ `getOutputStream()` (never close) | ✅ `getOutputStream()` (never close) |
| **Close stdin ⇒ SSH EOF** | ✅ `eofOnClose=true` → `sendEof()` | ✅ `eof()` → `SSH_MSG_CHANNEL_EOF` | ✅ writes `CHANNEL_EOF` |
| Host key: accept-all | `AcceptAllServerKeyVerifier` | `StrictHostKeyChecking=no` | `PromiscuousVerifier` |
| Host key: accept-new (TOFU) | `KnownHostsServerKeyVerifier` → `acceptUnknownHostKey` | ⚠️ **not native** — needs custom `HostKeyRepository` | `OpenSSHKnownHosts` + `write()` |
| Host key: reject changed | ✅ `ModifiedServerKeyAcceptor` hook | ✅ only if you use a custom repository + `StrictHostKeyChecking=yes` | ✅ `OpenSSHKnownHosts` |
| Password auth | ✅ | ✅ `Session.setPassword` | ✅ `authPassword` |
| Keyboard-interactive / 2FA | ✅ | ✅ `UIKeyboardInteractive` | ✅ `AuthKeyboardInteractive` |
| Ed25519 on Android <33 | needs BC or `net.i2p.crypto:eddsa` | needs BC (`bcprov-jdk18on`) | needs BC (already bundled) |
| Official Android support statement | **explicitly not a goal** (see quote) | none found | none found |
| SSH agent | via `tomcat-apr` (native `.so`) | agentproxy integrated | needs **Java 16+** for built-in transport |
| API style | async NIO + `AutoCloseable` trackers | blocking, thread-per-connection | blocking |

**Real options, condensed.** Exactly three production-grade pure-Java choices plus one Android-specific one.
I found **no** Kotlin-native or Android-specific SSH *client* library in a comparable maturity class.
(Android-specific SSH work I could confirm is the *server*-oriented `AndroidOpenSSLSecurityProviderRegistrar`
in `sshd-contrib`, which is unverified by its own maintainers.)

| Library | Coordinates | Version | License | Java | Android verdict |
|---|---|---|---|---|---|
| Apache MINA SSHD | `org.apache.sshd:sshd-core` | 2.20.0 / 3.0.0-M6 | Apache-2.0 | 8 | Works (Java 8 bytecode, API 26 floor) but **maintainers disclaim Android support** |
| JSch (mwiede) | `com.github.mwiede:jsch` | 2.28.7 | Revised BSD + ISC | 8 | Best fit; no Android statement but no Android-hostile code |
| sshj | `com.hierynomus:sshj` | 0.41.1 | Apache-2.0 | 8 | Functional; heavy BC dep; no Android statement |
| **`com.github.mwiede:jsch-agent`** | — | — | — | — | ❌ **does not exist.** `com/github/mwiede/` on Maven Central contains only `dockerjava`, `feign-validation`, `jedis-mock`, `jsch`, `metrics-feign`. The agent-proxy modules are `com.jcraft:jsch.agentproxy.{core,jsch,sshj}` at **0.0.9**, and JSch's README states they "where integrated in this fork" as of release 0.1.66 |
| Original JSch | `com.jcraft:jsch` | 0.1.55 (frozen) | Revised BSD | — | ❌ unmaintained; README: "No active maintenance of JSch at SourceForge" |

### 2.3 Local port forwarding — the critical capability

All three can do it, with these exact APIs:

| Library | API | Dynamic port? |
|---|---|---|
| JSch | `int Session.setPortForwardingL(int lport, String host, int rport)` — binds `127.0.0.1` by default. Also `setPortForwardingL(String bind_address, int lport, String host, int rport[, ServerSocketFactory ssf[, int connectTimeout]])`. Teardown: `delPortForwardingL(int lport)` | ✅ `lport=0`; **returns** the bound port |
| MINA SSHD | `ExplicitPortForwardingTracker ClientSession.createLocalPortForwardingTracker(int localPort, SshdSocketAddress remote)` and `(SshdSocketAddress local, SshdSocketAddress remote)`; lower level `SshdSocketAddress startLocalPortForwarding(local, remote)`. `SshdSocketAddress.LOCALHOST_ADDRESS` is `("127.0.0.1", 0)`. Tracker is `AutoCloseable` | ✅ javadoc: "The local port - **if zero one is allocated**" |
| sshj | `LocalPortForwarder SSHClient.newLocalPortForwarder(LocalPortForwarder.Parameters parameters, ServerSocket serverSocket)`; then `listen()` (blocking) / `listen(Thread)` / `close()` / `isRunning()`. `Parameters(String localHost, int localPort, String remoteHost, int remotePort)` | ⚠️ You bind it: `new ServerSocket(0, backlog, InetAddress.getByName("127.0.0.1"))`, then `getLocalPort()` |

⚠️ **MINA SSHD requires `client.setForwardingFilter(AcceptAllForwardingFilter.INSTANCE)` or local
forwarding fails** — see §1.4.

---

## 3. Detailed findings

### 3.1 Embedding a Node.js runtime in an Android APK

**`nodejs-mobile` — the only real candidate, and it is not viable.**

- Repo: <https://github.com/nodejs-mobile/nodejs-mobile> (the project moved out of
  `JaneaSystems/nodejs-mobile`, whose last push was **2021-10-27**; it is now a fork).
- 874 stars, **46 open issues**, last push **2026-04-30** — so the *repo* has some life, but the
  **last release is v18.20.4 on 2024-10-07**.
- License: the `LICENSE` file is the standard Node.js MIT text (GitHub reports `NOASSERTION` because the
  file also aggregates third-party licences — OpenSSL, V8, etc. — as upstream Node does).
- Node version shipped: **18.20.4**. Node 18 EOL was **2025-04-30**.
- ABIs per the official Android guide: `armeabi-v7a`, `x86` (**discontinued**), `arm64-v8a`, `x86_64`.
- Build prerequisites: CMake, NDK **r24+**, minSdk 21 (guide lists API 24 SDK components).
- **`child_process` and `cluster`: not available.** Also unavailable: `intl`, V8 inspector/debugger,
  `process.stdin`; `os.cpus()` returns undefined on Android 8+; no hard links; `process.exit()` kills the app.
- **Native addons: supported**, but must be cross-compiled, and "only Linux and MacOS development machines
  are currently supported" for that.
- Only **one** Node instance per process (worker_threads are supported).
- **Cannot run inside a WebView** — Node runs on its own thread and must be bridged.
- Measured from the official release asset `nodejs-mobile-v18.20.4-android.zip`: the archive is **2.81 MB
  compressed**, and its first entry `bin/arm64-v8a/libnode.so` is **11,527 KB (11.3 MB) uncompressed**. The
  download did not yield a fully readable central directory, so the other three ABIs' sizes could not be
  confirmed — but the docs state the zip covers all four (see §5).

**Also evaluated and rejected:**

- **`nodejs-mobile-react-native`** (npm 18.20.4, 2024-10-07, MIT) — same core, same missing
  `child_process`; only relevant if you were building React Native.
- **`nodejs-mobile-cordova`** — 0.4.3, **2021-08-16**. Long stale.
- **`LiquidCore`** (<https://github.com/LiquidPlayer/LiquidCore>) — last release **0.7.10 on 2020-06-21**,
  repo last pushed 2023-01-05, 1034 stars / 67 open issues, MIT. **Effectively abandoned.**
- **`J2V8`** (<https://github.com/eclipsesource/J2V8>) — embeds **V8 only**: no Node stdlib, no `require` of
  Node modules, no `net`/`crypto`. Maven `com.eclipsesource.j2v8:j2v8` last proper release 6.2.1
  (2021-08-10); per-ABI metadata shows 6.3.0 lastUpdated 2025-11-13. Size is fatal regardless:
  **`j2v8` 6.3.0 AAR = 57,696 KB (~56 MB)**; **`j2v8_android_arm64-v8a` 6.3.0 = 32,745 KB (~32 MB)**.
- **`GraalJS`** (<https://github.com/oracle/graaljs>) — genuinely active (pushed 2026-09-30, UPL-1.0,
  2033 stars / 158 open issues), but it is an ECMAScript engine on Truffle/GraalVM, not Node: no Node stdlib,
  enormous footprint, and Android support has historically been constrained by `MethodHandle` availability
  (see oracle/graaljs issue #229 for API < 26). Not a route to running `src/remote.js`.
- **Node in a WebView via WASM (WebContainer)** — `@webcontainer/api` 1.6.4 (2026-04-14, MIT package).
  Rejected for four independent reasons:
  1. It "**relies on hosted proxies and server-side acceleration from StackBlitz to function properly**", and
     integrating it means agreeing to StackBlitz's Terms of Service — it is not a self-contained offline
     runtime.
  2. **Commercial licensing is required for production commercial use**: "Licensing is required for
     *production* usage of the API in a commercial, for-profit setting."
     (<https://webcontainers.io/enterprise>)
  3. Requires `SharedArrayBuffer`, hence **cross-origin isolation** (`COOP: same-origin`,
     `COEP: require-corp`) and HTTPS in production, plus `boot()` may be called only once per page.
  4. It emulates networking in the browser — **there are no raw TCP sockets**, so it cannot be an SSH client
     at all.
- **Termux / Termux:API** — Termux is very actively maintained (`termux/termux-app`, 61,757 stars, pushed
  2026-09-26; `termux-shared` is MIT). A third-party app can drive it via an Intent to
  `com.termux.app.RunCommandService` (action `com.termux.RUN_COMMAND`, extras such as
  `com.termux.RUN_COMMAND_PATH`, `..._ARGUMENTS`, `..._STDIN`, `..._WORKDIR`, `..._RUNNER`, plus
  `EXTRA_PENDING_INTENT` for results). But this requires the user to **install Termux**, hold
  `com.termux.permission.RUN_COMMAND`, and enable `allow-external-apps` — which directly violates the
  "must NOT require termux-required user setup" constraint. **Excluded by requirement, not by capability.**

### 3.2 Can an embedded Node spawn the `ssh` binary? — the critical question

**Two independent blockers, either of which is fatal.**

**Blocker 1: `child_process` does not exist in nodejs-mobile.** There is no `spawn`, no `exec`, no
`execFile`. This is documented as unconditional (§1.1). So the answer to "does `child_process.spawn` even
exist/work in nodejs-mobile?" is **no — the module is not implemented.** It is not a permissions issue, not
a sandbox issue, and not fixable by configuration. (This is also why `ssh2`-the-library is interesting here:
it avoids `child_process` entirely by speaking SSH in-process.)

**Blocker 2: Android's W^X / SELinux policy forbids executing files from app data.** This is settled policy,
verified at two levels.

*Official documentation* — Android 10 behaviour changes:

> "**Removed execute permission for app home directory.** Execution of files from the writable app home
> directory is a W^X violation. Apps should load only the binary code that's embedded within an app's APK
> file. Untrusted apps that target Android 10 cannot invoke `execve()` directly on files within the app's
> home directory."
> — <https://developer.android.com/about/versions/10/behavior-changes-10>

*SELinux policy* — AOSP `system/sepolicy/private/app.te` (verified on `refs/heads/main` via
`android.googlesource.com`):

- Executing from the APK is **allowed**:
  `allow appdomain apk_data_file:file { getattr open read ioctl lock map x_file_perms };`
  where `x_file_perms` = `{ execute execute_no_trans }`.
- Executing from app data is **not**:
  `allow { appdomain -isolated_app_all ... } { app_data_file ... }:file create_file_perms;`
  and `create_file_perms` contains **no** `execute` permission.
- Reinforced by `neverallow appdomain exec_type:file ... no_x_file_perms`.

**Consequence — the only workable shape for vendoring an `ssh` binary:** ship the binary inside the APK as a
`jniLibs` entry named like a shared object (e.g. `libssh_exec.so`), so it lands in the app's **native library
directory** under `apk_data_file`, which *is* executable; then `execve` that path. Downloading it at runtime
into `filesDir`/`cacheDir` and executing it **will fail** on API 29+.

**The `extractNativeLibs` trap (verified):** per the official manifest reference,

> "This attribute indicates whether the package installer extracts native libraries from the APK to the file
> system. If set to `"false"`, your native libraries are stored uncompressed in the APK. Although your APK
> might be larger, your application loads faster because the libraries load directly from the APK at
> runtime."
> — <https://developer.android.com/guide/topics/manifest/application-element>

With `extractNativeLibs="false"` (now expressed as `useLegacyPackaging = false` from AGP 4.2.0) there is **no
filesystem path to `execve`** — the library is mapped from inside the APK. So a bundled `ssh` binary forces
you to keep legacy packaging, giving up the size/startup optimisation for the whole app.

**Licensing / redistribution:** permissive and *not* the obstacle.

- **OpenSSH** is BSD-style.
- **Dropbear** — its `LICENSE` states "Dropbear contains a number of components from different sources,
  hence there are a few licenses and authors involved. **All licenses are fairly non-restrictive**", with the
  majority under an MIT-style licence (<https://github.com/mkj/dropbear>). Redistribution inside a
  proprietary APK is permitted with the usual notice/attribution obligations.

The real costs are engineering, not legal: cross-compiling against Android **bionic** (NDK), maintaining
that build, and dealing with a runtime that has no `/etc/passwd`, no home directory, no `ssh_config`, no
`known_hosts` convention and no `TERM` — so every option must be passed explicitly rather than reusing the
user's SSH configuration. And you would still need a JS runtime *with* `child_process`, which means
maintaining your own Node-for-Android fork, because nodejs-mobile is not it.

### 3.3 Port the ~400 lines to Kotlin — practical arguments, and the recommended library

**For:**

- **Code reuse:** the *logic* (~400 lines: connect, run remote command, parse readiness, forward a port,
  handle errors) ports cleanly and becomes shorter, because a library session replaces two subprocess
  lifecycles with stream reads. What does **not** port is the *JavaScript itself*.
- **Testability:** the jsdom suite cannot be reused verbatim (its subject — the `child_process` boundary —
  disappears). But the JVM side is highly testable: point the client at an in-process SSH server (Apache
  MINA SSHD can act as the server) or a disposable OpenSSH container, and keep the jsdom suite as the
  end-to-end/contract test. **Budget for rewriting tests; this is the main real cost of the port.**
- **APK size:** **599,970 B** (sshj, plus ~10.2 MB of BC/slf4j) / **1,937,523 B** (MINA SSHD) /
  **714,740 B** (mwiede jsch), versus **~11.3 MB per ABI** for `libnode.so` alone, plus a vendored ssh
  binary, plus (for BouncyCastle-keyed paths) `bcprov-jdk18on` at **8,919,063 B** and `bcpkix-jdk18on` at
  **1,165,716 B**. Roughly a **10–20× size reduction** on the transport layer.
- **Long-term maintenance:** you are on the JVM's supported surface, tracking libraries that release
  monthly, with no cross-compilation and no EOL runtime. Note that a JVM/Kotlin-only app also **needs no
  native code at all**, which means the 16 KB page-size requirement simply does not apply to it — unless
  BouncyCastle or another dependency brings native libs.
- **Distribution:** the whole 16 KB-page and per-ABI-split problem set disappears.

**Against:**

- The ~400 lines are rewritten, not moved, and the test suite is rewritten. Call it a small, well-scoped
  project rather than a mechanical port.
- Behavioural differences you must re-earn: `ssh` binary semantics (agent forwarding, `ProxyJump`,
  `known_hosts` hashing, `~/.ssh/config` parsing) are *free* with the real client and must be reimplemented
  or explicitly dropped with a library. If `dsh-tabs` relies on the user's `~/.ssh/config` or an SSH agent,
  scope that carefully — it is the most likely place the port gets expensive.

**"Does a Kotlin SSH library mean no ssh binary at all, and does that change the other options?"** **Yes, and
yes.** With a library there is no subprocess, so there is nothing to `execve`: no `child_process`
requirement, no W^X issue, no SELinux question, no `jniLibs`-as-binary trick, no `extractNativeLibs`
sacrifice, and no OpenSSH/Dropbear cross-compile. It renders "embedding a Node runtime" moot (you don't need
one) and "can it spawn ssh?" moot (you don't need to spawn anything). It also means the existing Node source
does not need to keep existing at all on Android — the two clients can diverge, each idiomatic.

#### Maven

```xml
<dependency>
  <groupId>com.github.mwiede</groupId>
  <artifactId>jsch</artifactId>
  <version>2.28.7</version>
</dependency>

<!-- Required on Android for ssh-ed25519 / curve25519-sha256 / chacha20-poly1305.
     Android's JCE has Ed25519 signatures and XDH only at API 33+. -->
<dependency>
  <groupId>org.bouncycastle</groupId>
  <artifactId>bcprov-jdk18on</artifactId>
  <version>1.84</version>
</dependency>
```

Gradle: `implementation("com.github.mwiede:jsch:2.28.7")` and
`implementation("org.bouncycastle:bcprov-jdk18on:1.84")`. No `coreLibraryDesugaring` is required for the
libraries themselves (all real-classpath bytecode is Java 8 / major 52).

> **BC on Android caveat:** Android ships a cut-down provider named `BC`. Register BC explicitly and be aware
> of the provider-name collision. MINA SSHD's Android doc recommends the pattern
> `Security.removeProvider("BC"); Security.addProvider(new BouncyCastleProvider());`. BC's own guidance is
> that the Android platform BC is not the same as the upstream library — verify the effective provider list
> on a real device.

#### Minimal sketch

```kotlin
import com.jcraft.jsch.*
import java.io.OutputStream

class SshSession(host: String, port: Int, user: String, privateKeyPem: ByteArray) {

    private val ssh = JSch()
    private lateinit var control: Session      // connection #1: exec, stdin held open
    private lateinit var tunnel: Session       // connection #2: -N -L
    private lateinit var exec: ChannelExec
    private var stdin: OutputStream? = null
    private var localPort = -1

    init {
        // ---- TOFU + pinning: custom repository -------------------------------
        // JSch's "no" also accepts CHANGED keys, so we implement accept-new ourselves
        // and keep StrictHostKeyChecking=yes so a mismatch throws.
        ssh.hostKeyRepository = TofuHostKeyRepository(pinnedKeys)

        // In-memory key, no file needed on Android (byte[] overload).
        ssh.addIdentity("app-key", privateKeyPem, null, passphraseOrNull)
    }

    /** Connect + run a command, streaming stdout while stdin stays OPEN. */
    fun startRemoteServer(command: String, onStdout: (ByteArray, Int) -> Unit) {
        control = ssh.getSession(userName, host, port).apply {
            setConfig("StrictHostKeyChecking", "yes")   // our repo already did TOFU
            setConfig("PreferredAuthentications", "publickey,keyboard-interactive,password")
            // Interactive prompts, incl. 2FA:
            userInfo = object : UserInfo, UIKeyboardInteractive {
                override fun promptPassword(m: String) = true
                override fun promptPassphrase(m: String) = true
                override fun promptYesNo(m: String) = true
                override fun showMessage(m: String) {}
                override fun getPassword(): String = secret
                override fun getPassphrase(): String = passphrase
                override fun promptKeyboardInteractive(
                    destination: String, name: String, instruction: String,
                    prompt: Array<String>, echo: BooleanArray
                ): Array<String> = otpResponses(prompt)   // <-- 2FA hook
            }
            connect(20_000)
        }

        exec = control.openChannel("exec") as ChannelExec
        exec.setCommand(command)
        exec.setErrStream(System.err)
        // MUST be called BEFORE connect(): JSch warns otherwise.
        val stdout = exec.getInputStream()
        exec.connect(20_000)
        // Remote stdin. Never close it until teardown.
        stdin = exec.getOutputStream()

        Thread {
            val buf = ByteArray(8192)
            while (true) {
                val n = try { stdout.read(buf) } catch (e: Exception) { break }
                if (n < 0) break
                onStdout(buf, n)     // parse readiness line -> loopback URL + token here
            }
        }.apply { isDaemon = true }.start()
    }

    /** Local forward; returns the OS-allocated local port. */
    fun openLocalForward(remoteHost: String, remotePort: Int): Int {
        tunnel = ssh.getSession(userName, host, port).apply {
            setConfig("StrictHostKeyChecking", "yes")
            connect(20_000)
        }
        // lport = 0 -> OS allocates; the method RETURNS the bound port.
        localPort = tunnel.setPortForwardingL(0, remoteHost, remotePort)
        return localPort
    }

    /** Teardown: closing stdin sends SSH_MSG_CHANNEL_EOF -> remote server exits. */
    fun close() {
        runCatching { stdin?.close() }          // <-- the load-bearing teardown signal
        runCatching { exec.disconnect() }
        runCatching { control.disconnect() }
        runCatching { if (localPort > 0) tunnel.delPortForwardingL(localPort) }
        runCatching { tunnel.disconnect() }
    }
}

/** accept-new + pin: TOFU on first sight, reject on change, persist on accept. */
class TofuHostKeyRepository(private val store: MutableMap<String, ByteArray>) : HostKeyRepository {
    override fun check(host: String, key: ByteArray): Int {
        val known = store[host] ?: return HostKeyRepository.NOT_INCLUDED  // 1
        return if (known.contentEquals(key)) HostKeyRepository.OK          // 0
               else HostKeyRepository.CHANGED                              // 2 -> throws, because shkc=yes
    }
    override fun add(hostkey: HostKey, ui: UserInfo?) {
        store[hostkey.host] = hostkey.key
        persist(store)                       // <- your EncryptedSharedPreferences / Room write
    }
    override fun remove(host: String, type: String) { store.remove(host); persist(store) }
    override fun remove(host: String, type: String, key: ByteArray?) { store.remove(host); persist(store) }
    override fun getKnownHostsRepositoryID(): String = "app-pinned"
    override fun getHostKey(): Array<HostKey> = emptyArray()
    override fun getHostKey(host: String?, type: String?): Array<HostKey> = emptyArray()
}
```

**API-ordering and lifecycle gotchas verified in source:**

- `Channel.getInputStream()` **must be called before `connect()`** — JSch logs
  `"getInputStream() should be called before connect()"` otherwise (`Channel.java:156–160`).
- stdout is backed by a `PipedInputStream` with a 32 KB buffer, resizable via the `max_input_buffer_size`
  session config (`Channel.java:162–171`). **Always drain it**, or the channel stalls.
- `getOutputStream().close()` is idempotent (`closed` flag, `Channel.java:296–304`), so a double-close
  during teardown is safe.
- JSch is a **multi-release JAR**: features needing newer Java (Ed25519, curve25519) only become active if
  the JVM supports them or BC is present. On Android, BC is what makes them work.

#### The remote command and the teardown contract, in library terms

The Electron client's contract is not the `ssh` binary's — it is the **protocol** in `src/remote.js`, and a
Kotlin client must reproduce exactly the same three things:

| Contract | Electron (`src/remote.js`) | Kotlin / JSch equivalent |
|---|---|---|
| Readiness line | stdout matched against `/dsh web:\s*(http:\/\/\S+)/`, complete lines only until the process exits | Same regex over the drained `ChannelExec.getInputStream()` |
| Remote program | POSIX: `dsh web --no-open --port 0` backgrounded, then `cat > /dev/null` to block on stdin. Windows: a PowerShell program passed with `-EncodedCommand` | Same command strings, built by the same rules (including `resolvePreamble()` and the `cd` tilde handling) |
| Teardown | Close the ssh client's stdin → the remote `cat` sees EOF → the server is reaped | `stdin.close()` → `Channel.eof()` → `SSH_MSG_CHANNEL_EOF` → identical remote behaviour |

Both sides expose the remote stdin as an `OutputStream` that is simply never closed until teardown, and both
convert `close()` into a real `SSH_MSG_CHANNEL_EOF`:

- **MINA SSHD:** `ClientSession.createExecChannel(cmd)`; stdout `getInvertedOut()` (an `InputStream` that, per
  its javadoc, "remains open after the channel has closed"); stdin `getInvertedIn()`; stderr
  `getInvertedErr()`; async variants `getAsyncOut()` / `getAsyncErr()`. `getInvertedIn()` is constructed with
  `eofOnClose = true` (`AsyncCapableClientChannel.java:135`), so `close()` → `sendEof()` →
  `SSH_MSG_CHANNEL_EOF` (`ChannelOutputStream.java:346–372`). Exit status `Integer getExitStatus()`; wait via
  `waitFor(Collection<ClientChannelEvent>, long)`.
- **sshj:** `Session.exec(cmd)` → `Session.Command` (extends `Channel`): stdout `getInputStream()`, stdin
  `getOutputStream()`, stderr `Command.getErrorStream()`, `getExitStatus()`/`getExitSignal()` (call `close()`
  first), `signal(Signal)`. `ChannelOutputStream.close()` writes `CHANNEL_EOF`
  (`ChannelOutputStream.java:172–184`).

This is the piece that makes the port cheap and the piece that must not drift. Treat `src/remote.js` as the
**normative** description of the protocol even after the Kotlin client exists, because it is the copy the
offline suite pins byte-for-byte against the Desktop plugin.

#### Auth on Android

All three support publickey, password, and keyboard-interactive. Key material can be supplied as **`byte[]`**
in JSch (`JSch.addIdentity(String name, byte[] prvkey, byte[] pubkey, byte[] passphrase)`), which avoids
writing private keys to the filesystem and lets you keep them in the Android Keystore / app-private storage.
Supported types on Android at minSdk 26–29:

- **RSA** — ✅ (`SHA256withRSA` is API 1+); RSA/SHA-1 is disabled by default in JSch ≥0.2.0, but
  `rsa-sha2-256`/`rsa-sha2-512` work.
- **ECDSA** — ✅ (`ECDSA`/`EC` are API 11+).
- **Ed25519** — ❌ **not available from the platform**: Android's `Signature` table lists `Ed25519 | 33+`,
  `KeyPairGenerator`/`KeyFactory`/`KeyAgreement` list `XDH | 33+`. JSch's README: *"In order to use
  ssh-ed25519 & ssh-ed448, you must use at least Java 15 or add Bouncy Castle (bcprov-jdk18on) to the
  classpath"*; likewise curve25519 KEX needs Java 11 or BC, and `chacha20-poly1305@openssh.com` needs BC.
  MINA SSHD's standards doc says the same for curve25519 on pre-Java-11. **So yes — there is a real Ed25519
  problem on older Android, and BC is the fix for all three libraries.**
- Interactive prompts: JSch `UserInfo.promptPassword/promptPassphrase/promptYesNo/showMessage` +
  `UIKeyboardInteractive.promptKeyboardInteractive(destination, name, instruction, String[] prompt,
  boolean[] echo)`; sshj `SSHClient.auth(user, new AuthKeyboardInteractive(new PasswordResponseProvider(...)))`;
  MINA SSHD lists keyboard-interactive as a supported auth method.

#### Host key handling, per library

JSch needs a custom `HostKeyRepository` for true accept-new (its `"no"` also accepts changed keys); MINA SSHD
has `KnownHostsServerKeyVerifier` with an `acceptUnknownHostKey` hook and a `ModifiedServerKeyAcceptor`, plus
OpenSSH-compatible option names `StrictHostKeyChecking` / `UserKnownHostsFile`; sshj has
`PromiscuousVerifier`, `FingerprintVerifier`, and a writable `OpenSSHKnownHosts`. The Electron client
currently uses `StrictHostKeyChecking=accept-new` (`src/remote.js:sshOptions`), which is exactly the
behaviour the JSch custom repository has to reimplement.

### 3.4 Reusing existing JavaScript in a *non-Node* JS engine

Short answer: **no — a small engine buys you the JavaScript language but none of the JavaScript you
actually have**, because the code is Node CommonJS that depends on Node built-ins, and no small engine
provides them.

**`Zipline` (Cash App / Square)** — <https://github.com/cashapp/zipline>. Genuinely thriving: release
**1.28.0 on 2026-09-29**, repo pushed **2026-10-01**, Apache-2.0, 2305 stars / 107 open issues;
`app.cash.zipline:zipline-android` AAR is **1,853 KB**. But it is aimed at running **Kotlin/JS** libraries
inside Kotlin/JVM and Kotlin/Native programs ("Zipline works by embedding the QuickJS JavaScript engine in
your Kotlin/JVM or Kotlin/Native program"). Its CLI, `zipline-cli`, exposes only `download` and
`generate-key-pair` — it is *not* a Node or CommonJS runtime. The README has no `require`/CommonJS/Node
support claim. (Note: `cashapp/quickjs-java` now serves the Zipline README — it was absorbed into Zipline.)

**Android/JVM QuickJS bindings** (maintenance status is the discriminator):

| Artifact | Latest | Date | Status |
|---|---|---|---|
| `wang.harlon.quickjs:wrapper-android` | 3.2.0 | **2025-05-15** | ✅ Maintained. AAR **2,221 KB**. README claims ESModule (`import`/`export`), promises, bytecode compilation, and **16 KB page size** support |
| `com.amplitude:quickjs-android` / `quickjs-java` | 1.0.1 | **2025-05-29** | ✅ Recently released |
| `io.github.dokar3:quickjs-kt` | 1.0.0-alpha13 | 2024-07-05 | ⚠️ Alpha |
| `OpenQuickJS/quickjs-android` | v0.2.1 | **2023-06-09** | ❌ Stale |
| `com.github.penfeizhou:quickjs4a` | 0.0.3 | 2022-06-16 | ❌ Stale |
| `io.webfolder:quickjs` | 1.1.0 | 2021-08-30 | ❌ Stale |
| `io.github.taoweiji.quickjs:quickjs-android` | 1.4.6 | 2021-06-20 | ❌ Stale |

Upstream engine: **`quickjs-ng/quickjs` v0.17.0 (2026-09-18), MIT, 3848 stars, pushed 2026-10-01** — the
actively maintained fork (Fabrice Bellard's original lives at <https://bellard.org/quickjs/> without GitHub
releases). `quickjs-emscripten` (npm) is at 0.32.0 (2026-02-16), MIT.

**Could such an engine run Node-style CommonJS?** Not in practice. These bindings give you a raw ES engine:
you can evaluate scripts and (in some) use ES modules. They do **not** ship `require()` resolution over
`node_modules`, and they do not ship `net`, `crypto`, `stream`, `Buffer`, `process`, or `fs`. You could
hand-roll a CommonJS loader for *dependency-free* modules, but `src/remote.js` needs exactly the built-ins
that are missing — starting with `child_process`.

**Could such an engine do SSH?** Only if a pure-JS SSH client existed that avoided Node built-ins. None does
(see §3.5). So a QuickJS-class engine cannot connect to anything.

### 3.5 Pure-JS SSH clients, and `ssh2` specifically

**`ssh2` (npm, `mscdex/ssh2`)** — <https://github.com/mscdex/ssh2>:

- Version **1.17.0**, published **2025-08-20**; repo last pushed **2026-08-20**; **5825 stars / 106 open
  issues**; **MIT**; `engines: node >= 10.16.0`.
- Dependencies: `asn1 ^0.2.6`, `bcrypt-pbkdf ^1.0.2`; optional `nan ^2.23.0`, `cpu-features ~0.0.10`.
- **Local port forwarding: yes.** The README documents `conn.forwardOut(srcIP, srcPort, dstIP, dstPort, cb)`
  with a worked example titled *"Forward local connections to port 8000 on the server to us"* — precisely
  the `ssh -N -L` equivalent the app opens today. Remote forwarding via `conn.forwardIn(...)` and dynamic
  SOCKSv5 forwarding are also documented.
- **But it is Node-only.** It needs `crypto`, `net`, `stream` and `Buffer`. It therefore **cannot** run in
  QuickJS, Zipline, or a browser.
- **Inside nodejs-mobile?** It does not need `child_process`, and nodejs-mobile does provide `net`/`crypto`/
  `stream`, so it is *plausible* — but I found **no verified report** of `ssh2` running on nodejs-mobile, and
  it still leaves you on an EOL runtime with ~11.3 MB/ABI and the testing/interop problems above. Treat as
  unproven (see §5).

**Other pure-JS SSH clients:** I found **no maintained pure-JavaScript SSH client that avoids Node's
built-ins**. `paramikojs` (a JS port of Python's paramiko) exists but is dormant. General-purpose web SSH
tools (GateOne, WebSSH-style projects) are server-side Python/Go that shell out to a real SSH stack; they are
not embeddable JS. **Conclusion: there is no way to get SSH from a small JS engine — a real Node (with
native crypto and sockets) or a real JVM SSH library is required.**

### 3.6 Distribution and APK size

**The "150 MB base APK limit" premise is out of date.** Current official limits (Play Console Help, retrieved
2026-10-01, <https://support.google.com/googleplay/android-developer/answer/9859372>):

| App component | Limit (compressed **download** size) |
|---|---|
| **APK (non-bundle, "legacy")** | **100 MB maximum APK size** |
| **AAB base module** | **500 MB** |
| Individual feature modules | 500 MB each |
| Individual asset packs | 1.5 GB each |
| Cumulative modules + install-time asset packs | 4 GB |
| Asset packs on-demand / fast-follow | 30 GB |
| Total maximum compressed download size | 34 GB |

Additional verified notes: apps larger than 1 GB must target minSdk 21+; above **200 MB** users on mobile
data see a non-blocking "large app" dialog. Google explicitly states that apps still publishing **APKs** are
subject to "legacy APK size limits (that is, a maximum APK size of 100MB)" and **not** the bundle limits.

**Realistic size per approach:**

| Approach | Per ABI | Universal (4 ABI) | Notes |
|---|---|---|---|
| **Kotlin port** | 0 | ~0.6–1.9 MB of JVM bytecode | Plus ~10.1 MB if you pull in `bcprov`+`bcpkix`; check whether your key types actually need both |
| `nodejs-mobile` | **~11.3 MB** (`libnode.so` arm64-v8a, measured) | ~25–35 MB *(other ABIs unverified)* | Plus app JS, plus `node_modules` |
| Vendored `ssh` ELF | ~2–6 MB *(not verified this session)* | additive | Only workable with legacy packaging |
| QuickJS binding | 0 | **2.22 MB** (`wrapper-android` AAR) / 1.85 MB (Zipline) | Useless without an SSH client |

**ABI splitting:** an **AAB** is the right delivery format — Play generates per-device splits and each device
downloads only its own ABI's native libraries, so the per-ABI figure is what users actually pay, not the
universal figure. (`splits { abi { ... } }` does the equivalent for APK sets; `bundletool` can generate and
locally test APK sets.) Note the interaction with `extractNativeLibs`: with `false`, native libs are stored
**uncompressed** in the APK — the document quoted in §3.2 says the APK "might be larger" but loads faster, so
download size and install size move in opposite directions.

**Is the 150 MB limit a concern? Not remotely.** Every viable option here is 1–35 MB. The binding constraints
on this decision are the `child_process` gap, the EOL runtime, and the W^X/SELinux rules — **not** APK size.

**One size-adjacent requirement that *does* bite the embedded-Node path:** apps targeting Android 15
(API 35) and higher must support **16 KB memory page sizes** on 64-bit devices, and — per
<https://developer.android.com/guide/practices/page-sizes> — "**Starting February 1, 2027**, if your app
updates don't support 16 KB memory page sizes, you won't be able to release these updates." nodejs-mobile's
shipped v18.20.4 binary predates its `release18-20-4+16kb-fix` branch and it has open issue #148 "Android
16KB Alignment". A pure-Kotlin app uses no native code and is unaffected.

---

## 4. Bottom line

| | Embed Node | **Port to Kotlin** | Vendor `ssh` binary |
|---|---|---|---|
| Reuses `src/remote.js` | **No** — no `child_process` | No, but the logic ports cleanly | No |
| Needs an egress-capable runtime | Yes (ssh2 or a fork) | No | Yes, **plus** a Node fork |
| Runtime support status | Node 18, **EOL 2025-04-30** | Actively released libs | Your problem forever |
| W^X / SELinux obstacles | Yes | **None** | Yes (solvable via `jniLibs`, but costly) |
| Transport size | ~11.3 MB/ABI | 0.6–1.9 MB (lib only) | +2–6 MB/ABI |
| Test suite | Not reusable | Rewrite (testable via in-process SSH server) | Not reusable |

**Port it.** Then delete the assumption that the Android app must share code with the Electron app: let the
Electron client keep `child_process` + the system `ssh`, and let the Android client be a native Kotlin SSH
client with an in-process `LocalPortForwarder`. The shared artefact should be the **protocol/contract**
(readiness line format, port-forward target, error taxonomy, teardown-by-EOF) — not the Node source.

---

## 5. What I could NOT verify

Stated plainly, because these affect confidence:

1. **`ssh2` actually running inside `nodejs-mobile`.** No first-hand or official report found. It does not
   need `child_process`, and nodejs-mobile provides `net`/`crypto`/`stream`, so it is plausible — but it is
   **unproven**. Note this is moot under the recommendation, since the Kotlin port needs no JS runtime.
2. **Per-ABI sizes of the other three nodejs-mobile ABIs.** `bin/arm64-v8a/libnode.so` was measured at
   **11,527 KB** from the official `nodejs-mobile-v18.20.4-android.zip`, but the download (2,945,421 bytes)
   lacked a readable ZIP central directory and yielded only that first entry. The docs say the archive covers
   `armeabi-v7a`, `x86` (discontinued), `arm64-v8a` and `x86_64`; the total and the other entries' sizes
   could not be confirmed. The universal-APK figure in §3.6 is therefore an estimate.
3. **Size of a cross-compiled `ssh`/Dropbear binary for Android.** None was built or measured. The
   "+2–6 MB per ABI" figure is an order-of-magnitude estimate, not a measurement.
4. **The exact state of nodejs-mobile issue #148 ("Android 16KB Alignment").** The issue's existence, the
   unreleased branch `release18-20-4+16kb-fix`, and the fact that the latest release tag (v18.20.4) predates
   it were confirmed. The issue's open/closed state and maintainer commentary could not be read because the
   GitHub API rate-limited unauthenticated requests and the HTML page is JS-rendered. **Inference:** the
   released binary is not 16 KB compliant. It was not confirmed that a compliant release exists — it appears
   not to.
5. **Whether Android ships any system `ssh` client.** No primary source was found; the premise given in the
   task (no system `ssh`) was relied on, which is consistent with AOSP/Toybox. Low risk, but not
   independently verified here.
6. **`sshj` / Apache MINA SSHD current state on Android specifically.** Their versions, licences, sizes and
   local-forwarding APIs were verified, and evidence of Android interest was found (e.g. sshj PR #586, "Make
   KeyType compatible with Android Keystore"). An official Android-support statement, current
   `java.nio.file`/NIO2 friction for MINA SSHD on Android, and the exact BouncyCastle dependency/conflict
   situation on Android (where the platform already contains `org.bouncycastle` classes) were **not**
   verified. **Prototype this first** — it is the single highest-value spike before committing to the port.
7. **Which mwiede/jsch licence applies.** GitHub reports `NOASSERTION`; it is a fork of JCraft JSch
   (BSD-style). The licence file was not read to confirm the exact terms.
8. **`Zipline`'s precise JS API surface.** From the README, the CLI's command list and the absence of any
   `require`/Node claim, it is a Kotlin/JS runtime rather than a Node/CommonJS runtime. Its available globals
   were not enumerated from source, so it cannot be ruled out that some hand-written, dependency-free
   CommonJS could be shimmed onto it. It remains unusable for this code either way, because no SSH client
   could run there.
9. **Google Play policy on apps that `execve` bundled binaries.** The OS-level permission story (§3.2) was
   verified, but Play Store *policy* (as opposed to technical capability) around shipping and executing
   bundled ELF binaries was **not**. If the vendoring path were ever pursued, check Play policy explicitly.
10. **J2V8 6.3.0's per-ABI artifact coordinates.** The `j2v8` and `j2v8_android_arm64-v8a` AARs resolved at
    6.3.0, but `j2v8_android_armv7l`/`j2v8_android_x86` 6.3.0 URLs 404'd; only the 6.2.1 layout was fully
    probed. Immaterial — J2V8 is rejected on other grounds.
11. **License fields that APIs reported as empty.** The npm registry returned no `license` for `ssh2`
    (GitHub's repo metadata says MIT) and none for the `nodejs-mobile` npm name (which is an unrelated
    1.0.0 ISC placeholder package, not the real project).
12. **Google Play policy and US export-control specifics — not verified at all.** `support.google.com` and
    `play.google.com` were unreachable from this environment (all requests fail; `developer.android.com` was
    also blocked and was worked around via Google's official mirror `developer.android.google.cn`). It could
    therefore **not be confirmed** whether a Play Console "export compliance"/encryption declaration is
    required, what the current targetSdk requirement is, or how the Device-and-Network-Abuse policy treats an
    SSH client. **This needs a manual check** against
    [Play export compliance help](https://support.google.com/googleplay/android-developer/answer/113770) and
    [Play target API level requirement](https://support.google.com/googleplay/android-developer/answer/11926878).
    On export control: **15 CFR 742.15** ("Encryption items") exists and places encryption items under EAR
    control ([Cornell LII e-CFR](https://www.law.cornell.edu/cfr/text/15/742.15)), and **15 CFR 740.13**
    states "encryption software subject to the EAR is not subject to the General Software Note"
    ([Cornell LII](https://www.law.cornell.edu/cfr/text/15/740.13)); the existence and title of
    **86 FR 16482 (2021-03-29)** were confirmed ([Federal Register](https://www.federalregister.gov/documents/2021/03/29/2021-05481/export-administration-regulations-implementation-of-wassenaar-arrangement-2019-plenary-decisions)).
    The precise scope of what reporting was eliminated, whether an annual self-classification report to
    BIS/NSA is still required for a given distribution model, and the current status of `enc@nsa.gov` /
    `webmaster@bis.doc.gov` were **not** verified. **Get legal review.**
13. **No APK size measurement.** Pre-shrink JAR byte counts were measured. No Android app was built, so the
    post-R8/post-D8 delta for `classes.dex` is unknown. BC in particular shrinks very substantially under R8
    with a keep-rule for the algorithms used.
14. **No device or emulator testing.** Nothing was run on Android. All library behaviour claims are from
    published source, documentation, or artifact inspection — not from a running app. In particular it was not
    confirmed that D8/AGP accepts these artifacts end-to-end (though all real-classpath bytecode is Java 8 /
    major 52, which is the relevant precondition).
15. **Whether the Android platform can backfill Ed25519 below API 33 via `ProviderInstaller`/Conscrypt** —
    not verified. The official algorithm tables say `Ed25519 | 33+` and `XDH | 33+`, and whether a newer
    Conscrypt can be bundled to lower that was not investigated.
16. **`net.i2p.crypto:eddsa` license not fetched.** Only that version 0.3.0 exists and the JAR is 63,292 bytes
    was confirmed. Its license text was not retrieved, and MINA SSHD's own docs say *"use of this dependency
    is not recommended"*.
17. **Android-specific bug history not exhaustively reviewed.** The issue trackers of jsch/sshj/mina-sshd were
    not read for Android-specific reports. The absence of an Android support statement for JSch and sshj is an
    absence of evidence, not evidence of absence.
18. **ConnectBot's library choice not verified.** ConnectBot is active (Apache-2.0, pushed 2026-09-29,
    `minSdk = "24"`, `compileSdk = "37"`) and depends on `libs.sshlib`, but which SSH library `sshlib` wraps
    could not be resolved (GitHub code search requires authentication, and the `connectbot/sshlib` lookup
    failed). Treat any claim that "ConnectBot uses JSch" as unverified.
19. **sshj's exact KEX name list.** Its README lists `curve25519-sha256@libssh.org` but not the RFC 8731 name
    `curve25519-sha256`; the actual registered names in code were not enumerated.
20. **MINA SSHD 3.0.0-M6 consumer implications.** Its parent POM sets `minimalJavaBuildVersion=24`; this is
    believed to constrain only *building* sshd, since classpath bytecode is Java 8, but no Android app was
    built against it to prove that. **Use 2.20.0 (stable), not the 3.0.0 milestone.**

---

## 6. Sources

**Node on Android**
- nodejs-mobile repo — <https://github.com/nodejs-mobile/nodejs-mobile>
- nodejs-mobile API differences (the `child_process` finding) — <https://nodejs-mobile.github.io/docs/api/differences>
- nodejs-mobile FAQ (native addons, single instance, no WebView) — <https://nodejs-mobile.github.io/docs/guide/faq>
- nodejs-mobile Android guide (ABIs, NDK r24+, CMake) — <https://nodejs-mobile.github.io/docs/guide/guide-android/getting-started>
- nodejs-mobile releases — <https://github.com/nodejs-mobile/nodejs-mobile/releases>
- Original (superseded) repo — <https://github.com/JaneaSystems/nodejs-mobile>
- `nodejs-mobile-react-native` — <https://www.npmjs.com/package/nodejs-mobile-react-native>
- Node.js release schedule (Node 18 EOL 2025-04-30) — <https://github.com/nodejs/Release/blob/main/schedule.json>
- LiquidCore — <https://github.com/LiquidPlayer/LiquidCore>
- J2V8 — <https://github.com/eclipsesource/J2V8>
- GraalJS — <https://github.com/oracle/graaljs>
- WebContainer quickstart (COOP/COEP, single instance, HTTPS) — <https://webcontainers.io/guides/quickstart>
- WebContainer commercial licensing — <https://webcontainers.io/enterprise>
- `@webcontainer/api` — <https://www.npmjs.com/package/@webcontainer/api>

**Android security / packaging**
- Android 10 behaviour changes (W^X, `execve` from app home dir) — <https://developer.android.com/about/versions/10/behavior-changes-10>
- AOSP `system/sepolicy/private/app.te` — <https://android.googlesource.com/platform/system/sepolicy/+/refs/heads/main/private/app.te>
- `android:extractNativeLibs` — <https://developer.android.com/guide/topics/manifest/application-element>
- 16 KB page sizes (Feb 1 2027 deadline) — <https://developer.android.com/guide/practices/page-sizes>
- Play size limits — <https://support.google.com/googleplay/android-developer/answer/9859372>

**JVM SSH**
- sshj — <https://github.com/hierynomus/sshj> · `net.schmizz.sshj.connection.channel.direct.LocalPortForwarder`
- Apache MINA SSHD — <https://github.com/apache/mina-sshd> · `TcpipForwarder.startLocalPortForwarding`
- mwiede/jsch (maintained fork) — <https://github.com/mwiede/jsch>
- Original JCraft JSch (abandoned; last release 0.1.55, 2018-11-26) — <https://www.mvnrepository.com/artifact/com.jcraft/jsch>
- ConnectBot (pure-Java SSH, no bundled binary) — <https://github.com/connectbot/connectbot>

**JS engines / SSH libraries**
- Zipline — <https://github.com/cashapp/zipline> · <https://cashapp.github.io/zipline/>
- quickjs-ng — <https://github.com/quickjs-ng/quickjs> · QuickJS original — <https://bellard.org/quickjs/>
- `wang.harlon.quickjs:wrapper-android` — <https://github.com/HarlonWang/quickjs-wrapper>
- `ssh2` — <https://github.com/mscdex/ssh2> · <https://www.npmjs.com/package/ssh2>

**Termux**
- termux-app — <https://github.com/termux/termux-app>
- `RUN_COMMAND` Intent API — <https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent>
- TermuxConstants (`RUN_COMMAND_SERVICE`, MIT) — <https://github.com/termux/termux-app/blob/master/termux-shared/src/main/java/com/termux/shared/termux/TermuxConstants.java>

**Vendored-binary licensing**
- Dropbear — <https://github.com/mkj/dropbear> (`LICENSE`: "All licenses are fairly non-restrictive")

---

## 7. Measurements reconciled by this merge

Two studies answered these questions in separate files, and **the same Maven artifacts carried different
numbers in each**. `Other document` is the architecture study this file absorbed; `This document` is the
library study it absorbed. Every number below was re-measured by downloading the artifact from Maven Central
on 2026-10-01 and reading its length, rather than by choosing between the two.

| Artifact | Other document | This document | Re-measured |
|---|---|---|---|
| `com.github.mwiede:jsch:2.28.7` | "698 KB" | 714,740 B | **714,740 B** ✅ |
| `com.hierynomus:sshj:0.41.1` | "540 KB" | 599,970 B | **599,970 B** ✅ |
| `org.bouncycastle:bcprov-jdk18on:1.84` | 8,738 KB | 8,919,063 B | **8,919,063 B** ✅ |
| `org.bouncycastle:bcpkix-jdk18on:1.84` | 1,123 KB | 1,165,716 B | **1,165,716 B** ✅ |
| `org.apache.sshd:sshd-core:2.20.0` | — | 970,864 B | **970,864 B** ✅ |
| `org.apache.sshd:sshd-common:2.20.0` | — | 966,659 B | **966,659 B** ✅ |
| `net.i2p.crypto:eddsa:0.3.0` | 63,292 B | 63,292 B | **63,292 B** ✅ |

The disagreement is not one rounding error, and **the two rows point in opposite directions**:

- **JSch and sshj were understated.** "698 KB" is 2.3% below the measured 714,740 B and "540 KB" is 10%
  below the measured 599,970 B. Neither matches its artifact in any unit, so neither was derived from *this*
  artifact's bytes. What the other document did measure is not recoverable from the text — an entry-size sum
  and an earlier artifact both fit, and the document does not say which.
- **BouncyCastle was overstated by ~1.9%.** 8,738 KB and 1,123 KB are *above* the measured 8,919,063 B and
  1,165,716 B, and are not this artifact's numbers in any unit either — a decimal KB figure for 8,919,063 B
  is 8,919.1, not 8,738.

The 10% error is the one that matters: it is the difference between sshj reading as "about the same size as
the others" and sshj reading as **the largest single JAR of the three**, which is part of why §1.4 rejects it.
Each column was internally consistent, which is exactly why neither study caught the other. **The byte counts
in §2.2 are the ones that survived, and every K/MB figure elsewhere in this document is derived from them.**

Three further differences the merge settled, none of them numeric:

- **The architecture conclusion is single-sourced.** Both documents recommended the Kotlin port; only one
  framed it as a three-way decision (embed / port / vendor) with the `child_process` evidence. That framing
  is §1.1–1.3 and it is now the only copy.
- **The `ssh2`-inside-nodejs-mobile question was raised in one document and answered in the other.** It is
  settled in §3.5 and remains unproven in §5.1, which is the honest state.
- **Neither document was checked against the other's sources.** The reconciliation above covers the numbers
  only. Claims that appear in both were not independently re-derived here.
