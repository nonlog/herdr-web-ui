# nonlog/herdr-web-ui：Fork 功能、修复与同步约束

本文记录相对 `devswha/herdr-web-ui` 的本地扩展，供后续 Agent 和维护者同步上游时核对。功能存在于源代码不等于已经安装；验证与部署记录见文末。

## 基线与同步范围

- Fork：`nonlog/herdr-web-ui`；插件 ID 仍为 `devswha.herdr-web-ui`，不得因仓库名称不同而更改。
- Windows 工作区：`D:\Workspace\herdr-web-ui`。
- 此次同步前的共同祖先：`50db970ee563bdba084ae499a2fc1f7aa29e5031`。
- 此次同步目标：上游 v0.4.1，`b223a3efa5f7ae20a559d57e63afb21b0acd3b7c`。
- 验证使用的 Herdr 基线：0.9.3；原生 Windows 不具备直接 `terminal attach`，不能误当成 Unix 平台。
- 只向用户 Fork 推送，不向上游提交 PR。所有助手创建的提交，author 与 committer 均为 `Codex <codex@openai.com>`。

## 必须保留的 Fork 功能

| 功能 / 修复 | 代码与测试 | 同步时不可破坏的行为 |
| --- | --- | --- |
| 原生 Windows 实时终端 | `server/terminal-control.ts`、`server/index.ts`、`server/terminal-control.contract.test.ts` | `terminal session control` 提供真实 ANSI 帧；无需 Windows node-pty sidecar；保持输入就绪、接管、连接竞争重试、终端更换后的恢复。 |
| 三种终端传输 | `server/index.ts`、`server/mirror.ts`、`shared/protocol.ts` | Unix direct attach、Windows control、旧桥接 mirror 分开处理；不要把所有 Windows 会话降回轮询截图。 |
| Codex Windows Chat mode | `server/codex.ts`、`server/codex.test.ts`、`server/windows-native.test.ts` | 同时识别普通和带 `\\?\` 前缀的 cwd / rollout 路径；规范化后仍校验文件位于会话目录内。 |
| Codex 跨目录恢复会话 | `codexTranscriptRows`、`cwdVariants`、`CWD_MATCH`、`codexTranscriptPath` | Windows 恢复选择器切到其他目录时，使用有界候选与唯一、充分的屏幕匹配；歧义时拒绝猜测，不选择错误会话。 |
| 公网滚轮请求合并 | `src/lib/terminalWheel.ts` 及测试、`PaneTerminal.tsx` | 应用内滚动将像素/行/页归一化，约 40 ms 合并一批，保留滚轮速度设置，避免高延迟链路累积大量重绘请求。 |
| 手机不争抢 PTY 尺寸 | `PaneTerminal.tsx`、`scripts/chat-size-regression.ts` | 手机 `attach` 使用 `keep_size:true`；焦点、键盘、字体、视口、聊天/终端切换不触发共享 PTY resize；显示较大网格时允许横向平移。 |
| 接入时的几何与画面顺序 | `server/index.ts`、双客户端浏览器回归 | direct attach 的 observer / keep-size 客户端也必须先收到共享 geometry 再收到 ANSI replay，避免按手机初始小网格解析宽画面造成截断。 |
| 独立 ANSI 历史视图 | `src/lib/terminalHistory.ts`、`PaneTerminal.tsx`、`PaneTerminal.css` | 实时 xterm 保持 `scrollback:0`；独立只读渲染器显示被动读取的真实历史，不用 `pane.scroll` 或 `terminal.scroll` 浏览历史。 |
| 缓存即时滚动 | `src/lib/terminalHistory.test.ts`、`scripts/windows-lens-browser-qa.ts` | 预取后只移动本地 viewport；同一快照不反复 reset / 重写全部 ANSI；新输出不打断正在阅读的位置；过期请求不能污染新窗格。 |

历史关键提交：`256b409` Windows 控制器、`4cd02b2` 恢复处理、`2876d2b` 合同测试、`66b361c` 公网滚轮合并；`832c5c7` 至 `4d15afa` 为独立历史的前期草稿。`241ec7a` 才把专用双客户端浏览器脚本真正加入 CI。早期 CI 全绿不能证明该脚本已经通过。

## “本地即时滚动”与“应用内滚动”

终端上方有可切换的滚动目标。触控设备默认 **本地即时滚动**；桌面保留 **应用内滚动** 的旧默认，并可手动切换以改善公网体验。选择保存在当前浏览器，不修改服务器设置。

**本地即时滚动** 用 `pane.read(source:"recent", format:"ansi")` 读取已经存在的历史，保留 ANSI 色彩。进入实时视图时预取 512 行，输出变化后的刷新间隔不短于 1.5 秒；深入历史按需扩大，最多 20,000 行。每个窗格世代只允许一个读取请求在途，切换窗格会中止旧请求，15 秒超时后可由用户重试。

已有缓存时，拖动立即改变本地位置，不等待网络确认。读取中的视图被冻结；底层实时终端继续接收新输出。反向滚动到底、发送输入或按“返回实时终端”退出历史。缓存未到达时显示加载状态，不伪造文字，不回退到会移动其他客户端的共享滚动接口。触控返回实时视图不会自行弹出软键盘。

这实现了“先本地响应”的目标，但不是预测尚未产生的终端内容。超出已缓存范围仍需要一次实际网络读取，键盘输入和 TUI 内操作也仍受网络 RTT 影响。

**应用内滚动** 把滚轮传给共享程序，供 Vim、菜单或 Agent TUI 等需要鼠标/备用屏幕滚动的场景使用。它是实际控制行为，可能改变共享程序的显示，不能声称此模式与其他客户端完全隔离。输入框、按键栏和直接输入在两种模式下均保留。

### 为什么不自动识别 TUI？

Herdr 0.9.3 的 `src/client/terminal_sessions.rs::write_terminal_session_output` 只导出终端 ANSI 帧及关闭消息，忽略独立的 `MouseCapture` 等消息。`BlitEncoder` 的输出是渲染后的单元格，不是应用原始模式序列；而直接 attach 的外层终端又有自己的备用屏幕和鼠标模式。因此 xterm 的 `buffer.active.type` / `mouseTrackingMode` 不可靠地代表实际应用模式。不能凭这些值自动判断该读历史还是向 TUI 发输入；当前使用明确的滚动目标，避免误操作。

## 本次吸收的上游功能

同步保留上游提交历史，不重写为一个无法追踪的源码拷贝。主要变化包括：v0.4.1 / remote bundle 21、分页设置、可定制手机按键栏、组合键和 IME 修复、桥接端待发送消息生命周期、Claude `/effort` 选择卡和命令回复、Agent 活动排序及已查看完成提示、更新前后版本说明，以及 CSP、剪贴板授权、焦点约束、Push HTTPS 校验、Token 失败退避等修复。

上游 `c04c760` / PR #582 已覆盖一部分 Codex Windows 路径前缀问题。本 Fork 同时保留上游的 `withoutVerbatimPrefix` / `storedCwds` 测试与 Fork 的路径安全检查、更多 cwd 变体及跨目录恢复逻辑。不要因为上游也修了“Windows 路径”就整块删除 Fork 的恢复算法。

合并重点检查：`PaneTerminal.tsx` 的粘滞修饰键、IME 和 pending-input；`server/index.ts` 新版 attachment claim 生命周期；协议能力同时包含 `pending-input` 与 `terminal-scroll`；旧 mirror 的输入失效检查；CI 中单独运行 Windows 控制器的双客户端回归。

## Pi 大会话 Chat 读取

Pi 的 `~/.pi/agent/sessions/` JSONL 是可分支的追加日志。之前 `piBranchSegments` 在活动分支总字节超过 64 MiB 时直接返回 `null`，服务端报 `branch_unreadable`，Chat 显示 `Conversation unavailable`，即使会话文件路径有效、Pi 本体仍正常运行。实测 97.6 MB、约 1.3 万条条目的真实 Pi 会话命中此问题。现在不以活动分支总字节数限制可读性；连续日志仍归并为一个 offset 区间，最新页读取最多 16 MiB、旧页最多 64 MiB，原来的有界扫描、分页和 `/tree` 分支选择全部保留。另以 4096 个非连续段限制极端碎片化历史的每次读取开销。真实会话只读诊断已恢复，读取最新 22 条历史约 220 ms；自动化测试另覆盖超 64 MiB 的区间元数据以及碎片化限制。

Fork 已包含上游 #582（对应 #518 的前两个 Windows Codex 路径前缀修复，`withoutVerbatimPrefix` 与 `cwd IN (?, ?)`）。`codex resume` / `codex resume --all` 交互恢复时缺失会话 ID 的第三项仍未被上游修复；Fork 自己的跨目录恢复候选匹配和 Windows CI 回归必须保留，不能被后续上游同步覆盖。这个 Codex 问题与 Pi 的大文件 Chat 不可用是两个独立故障。

## Chat Stop 与终端 Esc 中止链路

Chat 的 Stop 按钮不能向隐藏的 xterm 注入原始 `0x1B` 代替按键；普通物理 Esc 和手机按键栏 Esc 也不能一律当作裸字节。Pi、Codex、Claude Code 等 TUI 可能启用 Kitty 键盘协议，Escape 的真实编码要由 Herdr 根据 pane 当前协商协议决定。现在三处均经 WebSocket `keys: ["esc"]` 走 `pane.send_keys`，保留组合键、粘贴文本、IME 及离线不重放的原有约束；不自动发送 Ctrl+C，避免终止进程。连接未就绪时在 Chat/Terminal 显示失败说明。

`scripts/key-bar-customization-demo-regression.ts` 断言物理 Esc、按键栏 Esc 和 Chat Stop 各发送一条语义按键而不是 `input` 原始字节；`scripts/windows-lens-browser-qa.ts` 还在隔离窗格启动声明 Kitty 键盘协议的程序，检查 Herdr 实际传给程序的 Escape 编码。绝不对用户正在运行的 Pi、Codex 或 Claude Code 会话执行中止测试。

## 构建、验证与部署

**开发过程中的构建验证、发布打包和可下载产物使用 GitHub Actions，不能在 CI 失败时私自回退本机或 VPS 开发构建。正常插件安装、更新所必需的依赖安装和构建允许在目标机器执行。** 这两类操作必须区分，不得把开发构建约束扩大成禁止正常安装。源码检查、git diff 以及不构建项目的小单元测试也允许在本机执行。

CI `Native Windows install` 任务生成 `windows-runtime-<commit SHA>`，内含已经构建的 `dist`、Windows 依赖及同一提交的源码，并带 `ci-runtime.json`。产物保留 3 天。必须等同一提交的 fast、Windows 和 integration/browser 全部成功后才能部署，不能仅凭产物存在判断可上线。

普通 `herdr plugin install` 会执行 manifest 声明的 `bun install` 和 `bun run build`；这是本插件正常安装流程，允许执行。应用内正常版本更新所需的构建也允许，不再因为存在 `ci-runtime.json` 而拒绝更新。来源、分支、未提交改动及版本祖先关系等原有安全检查仍保留。CI 预构建包仍是可选的部署方式；更新时保留配置和状态。`scripts/plugin.ts start` 本身只启动 managed server。

### 原生终端底部截断修复

此前只让手机采用原生网格，电脑浏览器仍把自己的尺寸传入 `terminal session control`。Herdr 0.9.3 的控制连接会设置 `direct_attach_resize_locks` 并重设真实 PTY；当网页比原生窗口高，输入框就可能被画到原生窗口底部之外。原生窗口后续调整尺寸也受该锁影响，不能仅靠刷新网页处理。

现在 Windows control 始终使用原生 pane 的布局尺寸，电脑和手机网页都只是采用该网格。服务端拒绝把旧网页发来的 resize 应用于控制连接，避免未刷新的标签页再次破坏布局。一个共享的 `NativeGeometryFollower` 每 500 ms 串行读取布局，只在原生尺寸变化时更新控制连接；无连接时不读取，失败不猜测，过期请求不能改动已更换的控制连接。画面尺寸在对应 ANSI 帧之前发送，完整帧更新回放基线。

浏览器窗口、页面缩放及网页字体只改变本地视口；显示不下时在网页内查看完整网格，不改变原生输入框的位置。Unix direct attach 的既有尺寸规则不在本次改动范围内。回归测试额外启动真实原生 Herdr 前端，与更大的电脑网页同时打开，再缩小原生窗口，验证真实 PTY 行数始终跟随原生布局。

发布前至少核对：

1. `git diff --check`，类型检查，原有单元/集成/浏览器回归以及 Windows 安装测试。
2. 手机加入同一窗格不改变 native PTY 尺寸；触控历史不改变 `offset_from_bottom`；电脑继续显示实时新输出。
3. 被动历史保留颜色，连续滚动不重复解析全部文本，反向滚动与输入恢复实时。
4. 加入 800 ms 人工历史接口延迟后，热缓存手势仍先完成本地显示；结果与真实公网网络延迟分别记录。
5. Application 模式仍能向真实鼠标/备用屏幕测试程序发送滚动；observer 二维平移不退化。
6. 新旧 pane 请求隔离、失败重试、中文等本地化、手机键盘与聊天模式回归。
7. 安装后的 `/api/health.web_ui.revision` 与通过 CI 的 SHA 一致；同一个公网入口能获取新版本。

## 网络测量与验收记录

此次从 Windows 主机对 `/api/health` 进行两次 HTTP 首包测量：本地约 1.8 / 27.2 ms，公网 `herdr.414222.xyz` 约 1,314 / 2,415 ms，Tailscale 私网路径约 32.3 / 90.1 ms。它们包含建连/首包过程，不是手机实测，也不是 WebSocket 滚动 RTT。

这些结果支持在客户端消除逐次滚动等待的必要性，但不能证明 Cloudflare 线路问题已经修复。此次未切换 DNS、Cloudflare Tunnel 或 Tailscale 配置。实际 CI 回归结果、上线 SHA 和部署后测量应在交付时补充；不得把尚未运行的测试写为已通过。


### 已有验证证据

- CI `37757112276` 的 Integration and browser 任务通过：双客户端独立历史、ANSI 颜色、冻结阅读位置、输入恢复、共享尺寸保持、TUI 鼠标/备用屏幕操作、direct attach 和 observer 平移；该次历史接口额外延迟 800 ms，热缓存滚动响应 16.5 ms。此 run 的 fast 任务另有路径/翻译失败，不能将其当作整包发布验收。
- 真实 Windows 暂存服务（不是公网生产入口）通过双浏览器模拟：共享 viewport 保持 47 行，没有手机 scroll/resize 消息，输入正常，页面错误为零；三次缓存滚动约 51.1 / 3.7 / 3.6 ms。
- 新增 Windows Codex 路径和恢复回归至 CI 的 Windows 任务。26 项定向测试通过，包含跨目录恢复、混合 namespaced/plain 路径、目录穿越与外部符号链接拒绝。上游规范化为 plain 路径，测试比较同一规范形式，不放松真实路径包含关系。
- 公网生产效果与最终发布提交以交付时的完整 CI 结果和安装后实测为准，不能用暂存服务数值替代公网数值。
