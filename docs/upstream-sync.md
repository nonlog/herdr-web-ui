# Fork 自动同步上游提交

本 Fork 跟踪 [devswha/herdr-web-ui](https://github.com/devswha/herdr-web-ui) 的 `main`，保留 [Fork 功能基线](fork-features.md) 中的 Windows 原生终端、独立 ANSI 历史滚动、Pi 大会话和 Codex 恢复等定制。

## 完成标准

同步使用真正的 `git merge`，保留上游原始提交及其祖先关系。验证是 `git merge-base --is-ancestor <上游 SHA> main`，而不只是源码相同或 JSON 基线相同。上游没有继续推进时，GitHub 的 behind 数应为 0。

此前的源码补丁方案用 `git diff` / `git apply --3way` 把变更写入新的 Fork 提交，虽然代码更新，却留下 87 个上游提交不在 main 的历史中。该方案已停止使用；不能再用它宣称“上游提交已同步”。

`docs/upstream-sync-state.json` 的 `last_merged_sha` 记录实际合并的上游 SHA。脚本判断是否有新提交时以 Git 祖先关系为准。旧 `last_applied_sha` 仅用于诊断迁移；它不在 main 的历史中时，脚本拒绝自动处理，要求维护者完成真实合并。

## 自动化规则

- `.github/workflows/upstream-sync.yml` 每天检查一次，也可以手动运行。
- 普通上游提交通过 Git 的三方合并产生双父 merge commit，不压成源码补丁，不使用 `-X theirs` 或 `-s ours` 自动选择冲突。
- 无冲突候选发布到 `automation/upstream-sync-<Fork SHA>-<上游 SHA>`，显式触发只读权限的完整 CI。Windows、macOS、Fast、集成和浏览器验证全部通过，且 Fork / 上游 / 候选 SHA 未变化，才快进 main 到经测试的同一提交。
- 已存在的候选仅在父提交、源码树和生成标记全部一致时原样重用。任何不同都拒绝覆盖；不用 force-push，不改动人工解决过的分支。
- 认证、入口、Portal、同步脚本和 GitHub 本地 Actions 等敏感改动，即使 CI 全绿也保留 Draft PR 审核。
- Git 冲突会让工作流失败，路径写入 Actions Summary。不创建仅含报告的 PR；不改 main。
- 自动 token 推进 main 后显式启动 Website，因为 `GITHUB_TOKEN` 推送不会触发 push 工作流。
- 合并和后续提交的 author / committer 均为 `Codex <codex@openai.com>`。

## 工作流权限边界

GitHub 内置 `GITHUB_TOKEN` 没有工作流写入权限。上游新增提交历史中只要涉及 `.github/workflows/`，自动同步会明确失败并列出路径，要求维护者使用有相应权限的凭据审查、真实合并和验证。即使这些修改后来被上游撤回，也不把该历史当作普通源码推送。

这里不会退回到跳过工作流、复制源码、推进 JSON 基线的方案，也不会保存本机的高权限 OAuth token。需要无人值守处理这些提交时，应另行配置仅访问本仓库、具有必要权限的 GitHub App 或细粒度凭据。

## 维护者处理待审同步

从最新 Fork main 建分支，正常合并上游 main，核对 Fork 功能与工作流差异。保留经过审查的 Fork 工作流配置，处理实际冲突，并对最终提交运行完整 GitHub Actions CI。

**上游同步 PR 必须保留 merge parent，不能 squash 或 rebase 成没有上游祖先的提交。** 维护者将经验证的同一提交快进到 main。该规则是普通功能 PR squash 规则的同步例外。

完成后同时检查 main 的上游祖先关系、GitHub behind 数、实际 CI 结果和 `last_merged_sha`。工作流成功或源码基线相等不能单独作为完成证明。

代码和提交同步不会安装、构建或重启正在使用的 Windows 插件，也不会自动部署 `herdr.414222.xyz`。开发构建与发布仍使用 GitHub Actions。
