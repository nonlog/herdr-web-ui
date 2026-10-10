# Fork 自动同步上游

本 Fork 持续跟踪 [devswha/herdr-web-ui](https://github.com/devswha/herdr-web-ui) 的 `main`。目标是尽量自动获得上游新功能，同时保留 [Fork 功能基线](fork-features.md) 中的 Windows 原生终端、独立 ANSI 历史滚动、Pi 大会话、Codex 路径/恢复和 Esc 中止等定制。

## 自动化规则

- GitHub Actions 的 `.github/workflows/upstream-sync.yml` **每天检查一次**，也可手动运行。
- 基线文件 `docs/upstream-sync-state.json` 记录最后一次**实际处理并验证**的上游提交。初始基线为已人工解决冲突并通过 CI 的上游 v0.4.5。
- 新的普通源码更新使用 `git diff <上次上游提交> <最新上游提交>` 和 **Git 三方补丁合并**，仅应用变更增量；不重复回放先前已同步的内容。包括 UI、终端、API、依赖、测试及安装脚本，均可在无冲突且 CI 通过时自动进入 Fork。
- **所有 GitHub Actions 工作流文件单独跳过**，记录到 `workflow_changes_pending`。GitHub 内置 `GITHUB_TOKEN` 无法推送更新 `.github/workflows/` 的提交；源码改用单父提交携带变更，因此上游工作流修改不再阻塞其它功能的自动更新。不需要保存 PAT。上游工作流的新功能仍需日后单独审查和合入。
- 原生 `GITHUB_TOKEN` 仅在检查工作流中申请源代码、PR 与 Actions 所需权限，**不会运行来自上游的代码**。实际验证通过只读权限的独立 CI 执行。
- 合并候选发布到 `automation/upstream-source-sync`，工作流**显式触发完整 CI**。须全部通过 **Native Windows install**、**Native macOS session identity**、**Fast checks**、**Integration and browser**，且 Fork / 上游 / 候选提交 SHA 都未变化，才会把**经测试的同一提交快进到 `main`**。
- 正常成功不创建重复 PR；CI 失败保留候选分支，不更新 `main`；认证和入口保护文件变更即使 CI 全绿也留 Draft PR 审核。
- Git 三方补丁无法自动处理的冲突会在 Draft PR 中报告具体文件（跟踪文档 **不可直接合并**）。此前人工在 review 分支进行的修复不会被下一次定时检查强制覆盖。

## 当前与之前自动同步方案的区别

原方案尝试把上游的所有提交与工作流历史完整推送到 Fork：上游一旦改动 `.github/workflows/`，GitHub 即使授予 `contents: write` 也会拒绝机器人推送，因此停在仅用于跟踪的 PR。

新方案先由维护者完成一次**完整上游合并并建立基线**，后续机器人只对自上次基线以来的**源码增量**创建 Codex 身份提交，不引入上游需要 `workflows` 权限的提交历史。这样能够在 GitHub 的原生短期令牌权限下自动吸收绝大多数上游新增功能。仓库中依然保留已验证的完整上游祖先提交。

## 操作与验证

在 [Actions → Upstream sync](https://github.com/nonlog/herdr-web-ui/actions/workflows/upstream-sync.yml) 可以手动运行。日志会说明最新上游提交、CI 状态、是否更新 `main` 以及未自动同步的工作流文件。

合并失败的 Draft PR 仅用于定位冲突。维护者需从最新 Fork `main` 建分支，根据 `docs/fork-features.md` 解决冲突并验证；只有真正应用过的上游增量才可更新 `docs/upstream-sync-state.json`。

**代码自动同步不等于自动部署。** 安装中的 Windows 插件、正在运行的 Claude Code/Pi、`herdr.414222.xyz` 不由同步工作流停止、构建或重启。发行构建和生产安装更新必须遵守项目既有 GitHub Actions 验收规则。

## 安全约束

- 不使用 `-X theirs` 或 `--force` 覆盖 Fork 的定制源码/生产分支。
- 每个自动提交都是 Codex `<codex@openai.com>` 的 author 与 committer。
- CI 未全绿、出现冲突、SHA 发生竞争变化、关键认证文件被修改时，禁止自动更新 `main`。
- 上游工作流变更会记录在 state 中，不会伪称已自动合并；需要有工作流权限的维护者另行合并。
