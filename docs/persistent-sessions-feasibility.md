# 持久会话（persistent session）可行性研究

**问题：** 怎么让 dsh-tabs 里的一个 Session 变成「持久会话」——远端 Harness 在客户端断开后继续活着，
重新连上时回到同一个 Session，而不是必须一直保持远程连接？

**研究日期：** 2026-11-26。对照的 DSH 版本：本机已装 `0.2.2-rc.5`，以及 npm 上的最新 alpha
`0.2.3-alpha.2`。所有结论都给了文件:行号；没有实测的部分单独列在 §7。

---

## 0. 结论

1. **会话本身早就是持久的，断的从来不是会话。** 断线死掉的是两样东西：远端的 `dsh web` **进程**，
   和浏览器里的**那一页文档**。会话日志（`~/.dsh/sessions` 下的 JSONL）留在远端磁盘上，任何同
   `DSH_HOME` 的 Harness 都能重新打开它、补上被打断的 `turn/end`、继续对话。
2. **dsh-tabs 今天的设计是"一次连接 = 一个进程"**：每次连接起一个新的 `dsh web --no-open --port 0`，
   端口随机、token 每进程随机、本地转发口随机，拆除时按 stdin EOF 契约杀掉远端进程。没有任何
   "复用/重连"路径（`src/remote.js:146-151`、`src/connect.js:600`、`src/main.js:451-455`、`src/main.js:1911`）。
3. **alpha 没有 daemon/detach 开关**：`dsh --profile web` 的参数与 rc.5 **逐字相同**
   （`@deepseek-ai/dsh-web-app` 的 `src/startup.ts` 在两版里 SHA-256 相同：
   `dd04c1ef…55ed8`，参数只有 `--host/--port/--no-open/--public-url/--trusted-host/--tls-cert/--tls-key`），
   文档里也没有 service/daemon 段落。
   alpha 给的是三块**零件**：持久的浏览器身份（cookie 默认 30 天、签名密钥落盘、跨 Host 重启仍有效）、
   单写者 + 并发读者的 SQLite 会话存储（非默认）、以及"离线会话可被唤醒/寻址"的 `session_send_message`
   （默认关闭）。它自己明说：**Host 必须一直运行且可达，本插件不提供隧道或远程唤醒**
   （`dsh-client-remote-connection/README.md:150`）。
4. 所以缺的那一块**只能由 dsh-tabs（或操作者的服务管理器）补**：远端进程常驻 + 隧道可重连 + 页面/身份不丢。
   这是三层，可以分开做。原先最不确定的"Windows 进程能不能脱离 ssh 会话"，2026-11-26 用 WMI 路线绕开了
   并实测通过（§11）：进程的父级是 `WmiPrvSE.exe`，创建者退出后照样服务；日志里 6.6 s 就有带 token 的 URL。剩下的风险是 dsh-tabs 内部的
   "复用/重连/不销毁文档"，不是未知的 Windows 行为。

---

## 1. 现状：一次连接的生命周期

```
ssh #1  ──> 远端 shell: dsh web --no-open --port 0 & child=$!; cat > /dev/null; kill $child  (src/remote.js:149-150)
             │ 就绪行 "dsh web: http://127.0.0.1:<远端口>/?token=<每进程随机>"
ssh #2  ──> ssh -N -L 127.0.0.1:<本地随机口>:127.0.0.1:<远端口>            (src/connect.js:600-606)
             │ 客户端把 URL 重建成 http://127.0.0.1:<本地口>/?token=…     (src/connect.js:629)
webview ──> 首屏 GET /?token=… 换 303 + Set-Cookie: dsh-auth-<host:port>，再 303 到 ./
```

拆除是**故意的杀死**：客户端关掉 ssh #1 的 stdin（`src/connect.js:659-674` 里顺序固定为 stdin 先、kill 后），
远端 shell 从 `cat > /dev/null` 读到 EOF 后 `kill` 子进程（`src/remote.js:150`）。Windows 远端是同一个契约，
外加 `finally` 里 `taskkill /T`（`src/remote.js:345`）和"下次启动时按记录收割上次泄漏"
（`src/remote.js:308`，记录文件 `%LOCALAPPDATA%\dsh-tabs\remote-harness.json`，字段见 `src/remote.js:342`）。

客户端侧同样是一次性的：

| 位置 | 行为 | 后果 |
| --- | --- | --- |
| `src/connect.js:600` | 每次连接 `freePort()` 新选本地口 | origin 每次变 |
| `src/main.js:451-455` | `stopTab` 清 `tab.url` | 渲染层销毁 webview 元素（`src/renderer/app.js:531-535`） |
| `src/main.js:1210` | 每次连接前清该标签的 cookie | 登录态不延续（原因见 `src/main.js:160-176`：随机端口的 cookie 会无限堆积，曾撑爆 16 KiB 请求头） |
| `src/main.js:177` | 分区是 `dsh-tabs-guest-<id>`，**in-memory** | localStorage 也随应用退出丢失 |
| `src/main.js:1911` | `before-quit` 停掉所有标签 | 退出即无远端进程 |

设备簿甚至明确不留端口：`src/devices.js:322-323` "No port field: the remote picks its own"。

---

## 2. 断的到底是什么：Host 端 / 客户端各一半

### 2.1 Host 端：浏览器走了，那一轮还在跑

- WebSocket 关闭只结束**逻辑流**（`follow`/`observe*`/`control`）：`dsh-api-gateway/src/stream-server.ts:182-204`
  在 socket close 后对每个 stream 调 `stop`。unary 调用**不**随载体取消（`dsh-api-gateway/README.md:45`
  "a unary call already running is not cancelled"；`methodSignal` 只给 stream 并入 peer signal）。
- 浏览器页面 Peer 是插件级**共享** Peer，不随 socket 关闭 dispose（`dsh-client-connection/src/rpc-host.ts:94`、`:129-137`）。
- `prompt` 在把输入放进 inbox 后就 ack（`dsh-api-session-controller/src/commands.ts:321-386`），
  Agent 的激活是后台 Promotion，不挂在 follow 上（`.../src/web/controller.ts:59-71`）。
- 断线期间缺的只是进程内的瞬态 chunk（`.../src/assistant-stream.ts:1`），重连后用 `assistantStream` 基线补齐。

**结论：** 只要 `dsh web` 进程不死，客户端断开期间 Agent 照常跑完、工具照常执行、定时任务照常触发。
客户端回来时看到的是结果，不是"被打断"。

### 2.2 会话日志：单写者、可只读、可续聊

- 每会话一个**内核写租约**（POSIX `flock`，Windows 由路径派生的命名信号量，进程死亡自动释放），
  第二个**写者**得到 `SessionAlreadyOwnedError`，UI 上就是 `session/writer-held`
  （`dsh-api-session-controller/src/agent.ts:199-200`；`dsh-docs/subsystems/persistence.md:11`）。
- **租约故意没有过期时间**：`dsh-session-persistence-jsonl/src/lease.ts` 的模块注释写明，
  一个活着但卡住的持有者会一直持有到进程退出，"there is deliberately no expiry that could expropriate
  a stalled writer whose resumed appends would tear the log"。所以**任何抢占都是错的**，
  所有权只能做在进程层（§12）。
- `open(id,'read')` **不取租约**，可以在另一个进程正在写时打开（`dsh-session-persistence-jsonl/src/index.ts:388-419`）。
- 进程被硬杀留下的半截 turn，由下一个打开者补 `turn/end { kind: 'interrupted' }`
  （`docs/subsystems/persistence.md:108-114`），然后正常续聊。
- alpha 的 SQLite 后端把这条推到"一个写者 + 多个读者共享数据库"（`dsh-session-persistence-sqlite/README.md:12`、`:57`），
  但**内置 profile 仍然用 JSONL**（同文件 `:12`），且导入后所有写者都必须换 SQLite（`:122`）。

### 2.3 客户端：刷新/断网本来就能自愈

- 物理 WS 重连是指数退避 500 ms → 上限 10 s、**到上限后无限重试**
  （`dsh-client-connection/src/recovery-config.ts:6-11` "retries continue at this cap"）。
- 会话选择存在浏览器里：`persist: { name: 'dsh.sessions.current' }`
  （`dsh-client-ui-workspace/src/client/navigation.ts:174`），加载时 `restoreSelection`
  （同文件 `:465-495`）→ 重新 `retain` → `follow({ activate: true })` → 从 snapshot 的游标补齐缺口。
- **没有 URL 深链**：客户端没有路由（无 `pushState`/`location.hash`）；`?token=` 的兑换只发生在 `pathname === "/"`
  （`dsh-client-connection/src/browser-auth.ts:269`），所以"带 token 直接打开某个 session"这条路在服务端就不通。
  恢复同一是靠 localStorage 里的选择，不是靠 URL。

---

## 3. alpha 里到底有什么（逐项核对）

| 能力 | rc.5 | 0.2.3-alpha.2 | 对"持久会话"意味着什么 |
| --- | --- | --- | --- |
| daemon / detach / background 启动 | 无 | **仍然无**（`dsh --profile web` 参数表与 rc.5 逐字相同；CLI 只有 profile/plugin/dump） | 进程常驻要外部做 |
| 浏览器 cookie | 每进程随机 launch token；cookie 用**落盘的签名密钥**、`cookieMaxAgeDays` 默认 30（`dsh-client-connection/src/index.ts:115`、`browser-auth.ts:14`、`:61-67`） | 抽出 `dsh-host-authentication-token`，并配套 QR/私密链接/设备配对（`dsh-client-remote-connection`） | **同 authority 重启后仍有效** → 只要本地口固定，应用重启后不必再拿 token |
| cookie 绑定 | 协议 + Host（HTTP 是 `host:port`，`browser-auth.ts:78-88`） | 同 | 本地转发口一变，登录态立刻作废 |
| 会话存储 | JSONL，单写者 | 新增 SQLite：单写者 + 并发读者（非默认） | 第二个进程可以**只读**看活跃会话，但仍不能两个写者 |
| 会话寻址 | 无 | `session_send_message`（默认关）：可给"不在线"的普通会话投递消息并先恢复它（`docs/user/session-control.zh.md:59`） | 最接近"会话作为持久实体"的雏形，但仅限**同一 Host 进程内** |
| 跨进程 live 列表 | 无 | 无（`ctx.sessionStatus` 是 Host 内存的已读/未读，重启即丢） | 另一个进程里的活会话在 UI 上仍显示为 cold |
| 客户端重连打磨 | 有 | 更细（retain facets、buffered pages、carrier-lost 分类） | 不改变"Host 必须活着" |

alpha 文档自己的边界写得很直白：

> "The Host must remain running and reachable after the original browser closes. This plugin supplies
> neither tunnelling nor remote wake-up."
> — `dsh-client-remote-connection/README.md:150`

> "原浏览器关闭后，Host 仍须运行且可访问。此插件不提供隧道或远程唤醒。" — 同文件中文版 `:158`

**所以："alpha 已经有雏形"这个判断对一半。** 它把"客户端身份持久化"和"会话可被寻址/唤醒"做了，
但**没有**做"Host 常驻"——那正是 dsh-tabs 缺的那块。

---

## 4. 目标拆成三层

| 层 | 目标 | 今天能不能做到 | 代价 |
| --- | --- | --- | --- |
| **L0 历史不丢** | 进程死了，会话还能重新打开、续聊 | **已经能做到**（§2.2） | 0（前提是没有第二个写者占着租约） |
| **L1 进程常驻** | 客户端断开/退出，远端 `dsh web` 继续跑，Agent 继续干活 | 要 dsh-tabs 或系统服务做（DSH 不提供） | 中等；Windows 有未知（§7） |
| **L2 客户端无缝** | 重新连上时回到同一个文档/同一个会话，不看到断线页 | 要 dsh-tabs 做（本地口固定 + 持久分区 + 不销毁 webview） | 小到中；主要是 dsh-tabs 内部改动 |

只做 L0 是"重开后从侧栏里点回那个会话"，中途那轮已经死了——不满足"不用保持连接"。
L1 + L2 才是用户要的形态。

---

## 5. 设计：常驻 Host + 固定本地口 + 可重连隧道

### 5.1 远端：一个被记录的常驻进程

新增"持久启动"变体（默认关闭，现有程序串一字节不动）。**启动方式的关键是让进程不成为 ssh 会话的后代**：
2026-11-26 在本机实测，用 WMI 创建（`Win32_Process.Create`）的 `dsh web` 父进程是 `WmiPrvSE.exe`
而不是 sshd 的 PowerShell，创建者退出后仍然存活并正常服务——会话拆除根本没有能到达它的句柄。见 §11。

- **Windows**：一个批处理启动器（`set "DSH_HOME=…"` + `node bin.js web --no-open --port 0 > log 2>&1`），
  用 `Win32_Process.Create` 起它；方法直接返回 pid。**不要**用会话内的 `Start-Process`：那条路是 ssh 会话的后代，
  能不能活过会话结束从来没人测过，而 WMI 这条路不需要那个答案。（命令行里的嵌套引号在 `cmd /c` 下有坑，
  实测 `cmd /c ""set "X=…" && …""` 会被拆错；用启动器文件，别拼内联命令。）
- **POSIX**：`setsid nohup dsh web --no-open --port 0 >>"$log" 2>&1 &`，把 pid 写进记录；**不**用
  `cat > /dev/null` 契约（那正是杀死它的东西）。`setsid` 缺失时退回 `nohup … &`，但那样它仍是会话的进程组成员，
  会话结束可能收到 `SIGHUP`——兜底不等于等价。
- 就绪行不再从 stdout 读（detach 后没有 stdout），改为**读日志**：记录文件写
  `{ pid, sup, port, token, started, node, binJs, cwd, home, version }`，`port/token` 从日志里那行
  `dsh web: http://127.0.0.1:<port>/?token=…` 解析出来（`src/remote.js:21` 的正则直接复用）。
  实测：全新的空 DSH home 上，从启动到日志里出现就绪行 **6.6 s / 6.9 s**（两次），不需要
  `dsh plugin install`，也不碰网络。
- 探测（每次连接先做）：读记录 → 校验 **pid 身份**（今天的写法见 `src/remote.js:308`：`node.exe` 且命令行含
  `web --no-open`；POSIX 用 `kill -0` + `ps -o args=`）→ 身份不符（pid 复用/文件陈旧）就删记录重起。
- **一个 DSH home 只允许一个 Host**：租约决定了"两个写者"没有意义（§2.2）。记录按 home 路径存放，
  探测到活着就复用；要停就显式"Stop host"（真杀 + 删记录）。

### 5.2 本地：固定端口 + 持久分区 + 保留文档

- **本地转发口按设备固定**（设备簿加 `localPort`，或按 host 稳定派生）。这是整件事的支点：
  origin 稳定 ⇒ (a) cookie 的 `dsh-auth-<host:port>` 名字稳定，不会堆积（§1 的 431 事故不会再发生），
  (b) 远端 Host 重启后登录态仍然有效——**已实测**：同一 `host:port` 上，用第一个实例签发的 cookie
  向重启后的新实例请求根路径，得到 `200` 和完整页面，没有带 token（§11），
  (c) 页面重载时 localStorage 里的会话选择还在。
- 持久标签用 `persist:dsh-tabs-guest-<id>` 分区，并且**不再每次清 cookie**（只在 origin 变了时清）。
  随之需要一个兜底：cookie 失配（远端 `client-connection:browser-session` 记录被重置、或 30 天到期）时
  页面会停在 401，此时"清该分区 + 用记录里的 token 重新 load"要是一条显式路径，而不是让人看见白屏。
- 渲染层：`detached` 状态下**不要**删 webview 元素、不要清 `tab.url`（`src/renderer/app.js:507-535`）。
  只要本地口的监听回来，页面自己的 WS 退避重连（§2.3）就会自愈，滚动位置和输入框都还在。
- 拆除拆成两个方法：`detach()`（只杀隧道，保留 URL/文档/远端进程）与 `terminate()`（今天的行为）。
  `before-quit` 对持久标签走 `detach`；`×` 也走 `detach`；只有显式 "Stop host" 才 `terminate`。

### 5.3 连接顺序

```
activate(tab):
  probe remote record ── alive? ──┬─ yes ─> 用记录的 port/token（不重启、不动会话）
                                  └─ no  ─> 持久启动 + 读日志拿 port/token + 写记录
  open tunnel 127.0.0.1:<固定本地口> -> 127.0.0.1:<port>
  waitForLocalPort → waitForHttpReady（src/connect.js:176-214 原样）
  webview.load(http://127.0.0.1:<固定本地口>/?token=…)
onTunnelExit → 退避重开隧道（不 failed、不销毁文档）
```

### 5.4 重开应用后的两种情形

| 情形 | 结果 |
| --- | --- |
| 远端 Host 还活着（关应用、换网络、休眠） | 重开应用 → 探测到活着 → 开隧道 → 页面加载 → `restoreSelection` 回到上次的会话 → `follow(activate:true)` 续上；期间跑完的轮次直接看到结果 |
| 远端 Host 死了（重启/被杀） | 探测失败 → 重新起 Host → 新 token → 页面加载 → 同一条会话从 JSONL 重新打开（补 `interrupted`），历史在，但那轮没了 |

---

## 6. 改动清单（最小可验证路径）

按顺序，每步都能独立验证：

1. **记录 + 只读探测**（`src/remote.js` 新增 `hostRecordPath`/`probeProgram`）：不改行为，先能在两个平台上
   回答"远端是不是已经有一个我起的 Host"。
2. **`detach()` / `terminate()` 拆分**（`src/connect.js:659-674`、`src/main.js:437-456`）+ 一个显式的
   `tabs:reap` IPC：此时还没有常驻启动，但 UI 已经能表达"断开但不杀"。
3. **固定本地口 + 条件清 cookie + 持久分区**（`src/connect.js:600`、`src/main.js:177`、`:1033`、`:1210`）：
   这一步本身就能让"同一 Host 内断线重连"回到同一页。
4. **持久启动变体 + 设备簿 `mode` 字段**（`src/remote.js:146-151`、`:242-348`、`src/devices.js:304-327`）。
5. **`onTunnelExit` 退避重连**（`src/main.js:1280-1295`）：注意必须接住 `cancelAttempt`（`src/main.js:376-422`
   修过的那个坑）。
6. **契约与测试**：`docs/contract.json` 只**新增**块，不改旧块（`tools/contract.cjs`），否则 Android
   `RemoteParityTest` 会被判红；`--port 0` 这个字面量同时被收割身份串（`src/remote.js:308`）与
   `tools/smoke.mjs:131`、`:189`、`:330` 钉着，持久变体若换端口必须一起改，漏一处收割会静默失效。

---

## 7. 风险与还没测的事

**2026-11-26 已经测掉的（§11）：** WMI 创建后父进程是 `WmiPrvSE.exe`、创建者退出后存活；重定向日志
6.6–6.9 s 后就绪行到达；同一 authority 上 cookie 跨进程重启仍然有效。

**还没测的：**

1. **Windows 注销/重启**：常驻进程当然不活；需要确认的是"下次登录后谁把它拉起来"
   （计划任务 `onlogon`，或者 dsh-tabs 探测到没有就起）。这决定 L1 的语义是"跨连接"还是"跨登录"。
2. **两个客户端同时探测/启动的竞态**：实现里已经用远端一把短命锁目录（`ensure.lock`）挡了，
   但"锁的持有者被硬杀、锁留了 2 分钟"这条恢复路径没有在真机上演练过。
3. **`WmiPrvSE.exe` 被回收时会不会带走子进程**（预期不会，Windows 没有"父死子死"的默认语义，
   但没测过长时间）。

**设计层面的风险：**

- **写租约会从"偶发 bug"变成"默认状态"**：常驻 Host 就是一个没人看着的写者。必须有可见状态 +
  一键收割，否则重演"新窗口打不开任何会话"（`src/remote.js:283-292` 记录的那次）。
- **token 落盘就是凭据落盘**：记录里的 launch token 能换 cookie。POSIX 要 `umask 077`/`chmod 600`，
  Windows 要 ACL；另外 `src/main.js:1277` 现在把带 token 的 URL 原样写进 transcript，持久模式下必须脱敏。
- **Windows 的 profile link 陷阱**：`dsh web` 在非交互会话里解析 `~/.dsh/profiles/*/node_modules` 的
  junction 时可能拿到 `UNKNOWN/-4094`，**在打印就绪行之前**就死（见本机用户级 AGENTS.md）。
  WMI 创建的进程同样在 Session 0（本机实测：现有 Harness 与探针都在 Session 0），所以同样会踩；
  要么用 `sync-web-profile.ps1` 那种"复制而不是链接"的 profile，要么别用 junction。
- **本地口固定 = 端口可能被占**：`freePort()`/`--port 0` 正是为了消灭撞口。折中是"本地口固定、远端口随机"：
  origin 稳、远端不撞。若本地口被占，要**显式失败**并提示，而不是静默换口（换口等于换 origin）。
- **一个浏览器/两个客户端**：桌面走 ssh 隧道，手机走 Tailscale 之类的直达地址——两者的 authority 不同，
  cookie 不能共用（alpha 的配对流程也要求 advertise 一个手机可达的非 loopback 地址）。
- **契约链条**：`src/remote.js` → `docs/contract.json` → Android。新增变体必须**新增块**，
  并把 `--port 0` 从收割身份串里参数化。

---

## 8. 不建议的做法

- **"每次连接换一个新 Harness，靠会话日志恢复"**：历史在，但那轮已经死了，工具副作用可能半途而废
  （`turn/end { interrupted }` 只是记账，不是回滚）。这不是持久会话。
- **两个 Harness 同时开着轮流看**：单写者租约决定了第二个只能是只读；写者转移不会自动发生。
- **把 `clearGuestSession` 留着而指望 alpha 的 30 天 cookie**：每次连接都清 jar，再长的 cookie 也没用。
  同理，本地口不固定时 cookie 名每连接一变，持久分区只会变成"一个端口的垃圾越积越多"的老问题。
- **在 dsh-tabs 里自己实现一个 relay/端口转发协议**：ssh 隧道已经够用，多一层只是多一处要重连的状态。

---

## 9. 今天就能用的临时方案（不改代码）

远端用一个守护起来：

```sh
# POSIX 远端：日志落盘，才拿得到那行带 token 的 URL
tmux new -d -s dsh 'dsh web --no-open --port 3080 2>&1 | tee ~/dsh-web.log'
# Windows 远端（当前用户登录时启动）
schtasks /create /tn dsh-web /tr "cmd /c dsh web --no-open --port 3080 > %USERPROFILE%\dsh-web.log 2>&1" /sc onlogon /f
```

从日志里取带 `?token=` 的那行；本地自己开一个转发（`ssh -N -L 3080:127.0.0.1:3080 <host>`，
dsh-tabs 的 Terminal 标签里跑也可以），再用系统浏览器打开那个 URL。连接断了网页会自己退避重连，
Host 一直在跑；token 直到 Host 重启都有效，之后重新取一行即可。

代价：它不在 dsh-tabs 的标签栏里、不会被自动重连、关掉终端标签转发就断。它只是证明 L1 的价值，
不是产品形态。

---

## 10. 下一步的决策点

1. 只做 **L1**（常驻 Host，重连后从侧栏点回会话），还是 **L1+L2**（固定本地口 + 持久分区 + 文档保活，
   回到同一屏）？后者体验好得多，改动集中在 dsh-tabs 内部，不牵动契约。
2. 持久模式是**逐设备开关**（推荐）还是全局默认？逐设备才符合"有些远端只是随手看一眼"的现实。
3. 远端记录文件放 `~/.dsh/dsh-tabs/host.json`，还是继续放 `%LOCALAPPDATA%\dsh-tabs`？建议统一到 DSH home
   旁边，这样"一个 home 一个 Host"的规则和租约是同一个坐标系。
4. Windows 走 `Start-Process` 还是**计划任务**？都不是：§11 实测推荐 **WMI `Win32_Process.Create` + 启动器文件**，
   它让进程的父级是 `WmiPrvSE.exe`，与 ssh 会话无关。计划任务只在"跨登录"（重启后自动拉起）时才需要。

---

## 11. 实测记录（2026-11-26，本机 `box-a`）

**约束**：不影响正在服务的 Harness（pid 2520，`127.0.0.1:57519`，来自移动端的 ssh 会话；
它自己的父级是 dsh-tabs 那个 `-EncodedCommand` PowerShell）。所有实验用**独立的临时 DSH home**
（`scratch/persist-test/home`）和独立进程，结束时全部清理；pid 2520 全程存活。

环境：Windows 11 `10.0.26300`，Node `24.20.0`，`@deepseek-ai/dsh` `0.2.2-rc.5`（npm 全局），
临时 home 是全新的空目录。

| 实验 | 方法 | 结果 |
| --- | --- | --- |
| 脱离 ssh 会话树 | `Invoke-CimMethod Win32_Process Create` 起启动器 | 进程链 `node` → `cmd` → **`WmiPrvSE.exe`**；创建者（pwsh）不是它的祖先 |
| 创建者退出后存活 | 创建后让创建它的 pwsh 结束，再从新进程查 pid | 存活（探针 20004；真实 `dsh web` 18892） |
| 就绪行落盘 | 真实 `dsh web --no-open --port 0`，stdout/stderr 重定向到日志，轮询日志 | **6.6 s / 6.9 s** 出现 `dsh web: http://127.0.0.1:<port>/?token=…` |
| 真的在服务 | `curl -c jar -L` 打开带 token 的 URL | `200`，41,120 B，页面含 `id="root"` |
| token / 端口每进程变 | 两次启动对比 | 端口 `53928` → `61841`，token 不同 |
| **cookie 跨 Host 重启** | 用第一个实例签发的 cookie（authority `127.0.0.1:53928`）向**重启后的新实例**（同端口）请求根路径，**不带 token** | **`200`** + 完整页面 —— 签名密钥确实持久化在 DSH home，cookie 绑定的是 `host:port` |
| `cmd /c` 内联引号 | `cmd /c ""set "X=…" && …""` | 被拆错：`'"set "PROBE_INLINE' is not recognized`；必须用启动器 `.cmd` 文件 |
| 全新 home 能否自举 | 空目录 + `DSH_HOME` | 自动生成 `profiles/web`、`storages`、`.credentials.yaml`，不需要 `dsh plugin install`，不碰网络 |

**没有测的**：真正的 ssh 会话结束（我们改成"父进程不在会话树里"，所以不需要这个答案）；
注销/重启后的拉起；§7 里的探测竞态。

**补充（2026-11-26 晚）**：上面这条"POSIX 没做成"已经被 `tools/live-persistent.mjs` 补上——对着
真机 `box-b`（Linux，装了 dsh）跑通了完整路径：`HOST started pid=858839` →
放弃隧道 → 再连 → `HOST adopted pid=858839`（同 pid、同端口、同 token、同本地口 41930）→
`HOST stopped pid=858839`。另外这台机器的登录 profile 会在会话里留一个占着 stdout 的后台进程，
**连 `ssh host 'echo hi'` 都不返回**；所以 ensure / stop 的 ssh client 在读完输出后必须主动 kill，
不能等 channel 退出（`awaitEnsure` 与 `stopPersistentHost` 都已按这个改了）。

**结论**：远端常驻在 Windows 上是可做的，而且比 `Start-Process` 更干净——WMI 创建返回 pid、
日志里有带 token 的 URL、cookie 让客户端不必每次重新登录。剩下的都是 dsh-tabs 内部的
"复用/重连/不销毁文档"，不是未知的 Windows 行为。

---

## 12. 所有权：一个 home 一个 Host

**问题**：另一个 dsh-tabs 忘了关，它的 Host 还活着，新 Host 一开就写不了那些 session
（`session/writer-held`）。能不能做所有权管理？

**能做，但层次是 Host 进程，不是 session 文件。** 理由见 §2.2：租约故意不过期，抢占会让日志撕裂；
而且 dsh-tabs 无法判断"持有者是不是卡住了"。所以正确的目标不是"换一个写者"，而是
**让第二个写者根本不必存在**。

### 12.1 不变量：同一 (机器, DSH home) 最多一个 Host

- 连接 = **认领（adopt）**，不是新建。远端有活着的 Host 就用它的 port/token 接上去，不杀、不重启。
- 于是"旧 dsh-tabs 忘了关"不再是个问题：两个客户端**附着到同一个 Host**，看到同一批 session。
  DSH 支持多个浏览器 peer 跟同一个会话（§2.3 的游标跟随），所以这是合法的"两个看客"，不是"两个写者"。
  两个客户端同时发 prompt 也安全——输入都进同一个 inbox。
- 旧客户端的退出/断线只 `detach` 隧道（§5.2），所以它关不关都不影响 Host。
- "忘了关"真正会留下的只有一条没用的隧道，和一个多余的窗口。

### 12.2 机制

| 步骤 | 做法 |
| --- | --- |
| 记录 | `$DSH_HOME/dsh-tabs/host.json`（Windows 也可放 `%LOCALAPPDATA%\dsh-tabs\hosts\<home-hash>.json`）：`{pid, port, token, home, started, node, binJs, cwd, version}`；POSIX `chmod 600`，Windows 收紧 ACL |
| 身份校验 | pid 活着 **且** 命令行含 `bin.js web`（Windows 照 `src/remote.js:308` 的写法）；pid 复用/记录陈旧就删记录 |
| 存活校验 | 远端连一次 `127.0.0.1:<port>`（POSIX `/dev/tcp`，Windows `Test-NetConnection`）。只信记录里的 pid 不算数 |
| 原子 | `probe → start → 写记录` 放在远端一把短锁里（`mkdir` 或 `flock`/`CreateNew`）。输家醒来重 probe，认领赢家的 Host，然后**杀掉自己刚起的那个** |
| 采用 | 认领时标签显示 "host pid=…, up 3h"，不显示"新连接" |
| 停止 | 设备菜单里显式 "Stop host"：杀 pid、删记录。**只有人能按** |

**两个补丁（实现前要定）：**

- **设备簿加 `home` 字段**（可选，默认远端用户的默认 DSH home）。没有它，"一个 home 一个 Host"只对
  "每台机器一个 home" 成立；有了它，同一台机器可以有两个互不干扰的 Host，也让"真机实测"能指向一个
  临时 home 而不碰正在用的那个。
- **从临时模式迁移过来要有提示**：某台设备一直是临时连接，现在打开持久模式时，上一次的临时 Host
  （sshd 的子进程）可能还在跑并占着 session。第一次切换要问一句"这台现在有一个临时 Host 在跑，
  停掉它并换成持久 Host 吗"，否则第一眼就是 `session/writer-held`。

### 12.3 真的被占用了：三种情况和各自的处理

1. **旧的 dsh-tabs / 旧 Host** —— 12.1 之后不会发生（会被认领）。
2. **有人在这台机器上手起了 `dsh web`** —— dsh-tabs 看不见它（没有记录）。它能做的就是：
   - POSIX：能**指名**持有者。`flock` 落在 `session.lock` 上，扫 `/proc/*/fd` 找指向该文件的 pid
     （比 `lsof`/`fuser` 少一个依赖），然后把 pid/命令行/启动时间显示在占用横幅里。
   - Windows：命名内核信号量没有可枚举的归属，**指不出 pid**；只能列出本机所有
     `node.exe … bin.js web` 进程让人选。这是 Windows 上的真实盲点，别假装能查到。
   - 横幅给一个"停止它并重试"的动作，仍然是人按。
3. **同机的本地标签与持久设备共用同一个 home** —— 本地标签也是一个 Host（`src/main.js:1863` 开机就起）。
   如果某台"远端"其实指向本机、且 home 相同，两者会争同一个 home。要么让本地标签也走同一份记录、
   要么拒绝在"已有本地 Host 的 home"上开持久设备。这条容易漏，写进设备校验里。

### 12.4 明确不做

- **不给租约加超时/心跳**、不自动抢占活写者——见 §2.2 的原文。
- **不做 watchdog**：Host 死了就死了，下次连接重新拉起；session 历史仍在，只是那轮没了。
  这正是"机器重启不用管"的同一句话。
- **不自动杀**别人的 `dsh web`：只能显示、由人决定。
