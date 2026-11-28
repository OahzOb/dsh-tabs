# dsh-tabs — agent notes

这个仓库的构建、测试、打包见 `README.md`。本文件只写**不知道就会犯大错**的东西：
测试套件的 scratch 删除规则，以及现在拦住它的机制。

## 一、给 agent 的硬性规则

1. **不要用外部环境变量里的路径去删东西。** scratch 只能是套件自己用 `mkdtempSync()`
   或 `<repo>\.tmp-*` 创建的目录；删除前必须过 `scratch-guard`。
2. **不要把 `DSH_HOME` / `DSH_TABS_TEST_HOME` 指向真实家目录**，哪怕只想「临时验证一下」。
3. **不要在仓库外的真实目录上跑 `tools/live-*.mjs`**：它们连的是设备簿里的真实机器。
   `tools/live-persistent.mjs` 的 `rm -rf` 只在默认 scratch（`/tmp/dsh-tabs-live`）时执行，
   传 `--home` 才安全；Windows 设备没有默认 scratch，必须显式传 `--home`。
4. `npm test` 会执行 `tools/main.mjs`，它真的会删 scratch home。跑之前先确认
   `test:guard` 是绿的；**不要跳过** `test:guard`，也不要为了跑通而绕过它。
5. 任何新增的删除逻辑都要走 `tools/scratch-guard.mjs`，并在
   `tools/scratch-guard.test.mjs` 里补一条反例（必须拒绝真实 home、`~/.dsh`、盘符根、
   含本仓库的父目录）。
6. 改源码或注释时**不要写本机绝对路径**：`tools/smoke.mjs` 里有一条策略检查
   （「no file names a directory that only exists on the machine this was built on」）
   会失败。用 `<root>`、`<home>`、省略写法或 loopback 地址。
7. `approval: never` 不要再回到任何 profile：删除、覆盖、历史重写这类操作必须在
   有人确认的情况下执行。这个 profile 已改成 `ask`。

## 二、现在有什么防护

- `tools/scratch-guard.mjs`：`scratchProblem()` 拒绝任何「是 / 包含 / 会删掉」下面这些路径
  的候选：`$HOME`、`$DSH_HOME`、系统目录（`C:\Windows`、`Program Files*`、`ProgramData`、
  `C:\Users\…`）、本仓库根，以及已经含 `.dsh` 的目录（那是别人的 DSH home）。
  `assertScratch()` 抛错，而不是退回到一个「安全」目录——静默回退会掩盖真正的错误配置。
- `tools/main.mjs` 与 `tools/smoke.mjs` 在**每一次** `rmSync` 之前都调用它；
  `package.json` 的 `test:guard` 排在 `npm test` 最前面，回归用例见
  `tools/scratch-guard.test.mjs`。
- `README.md` 的 `DSH_TABS_TEST_HOME` 条目写明了「值会被校验」。

## 三、动测试相关代码后的验证清单

```powershell
cd <root>               # the dsh-tabs checkout
npm run test:guard      # 必须 ok
npm test                # 全绿再提交
git status --short      # 工作区干净
```

守卫与提交记录：`tools/scratch-guard.mjs`，以及 `tools/scratch-guard.test.mjs` 里的反例。
