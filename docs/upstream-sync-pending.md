# Upstream sync waiting for workflow-change review

This is a tracking report only; merging this document does NOT integrate upstream code.

Fork base: 5c8ee31662f8ecef7532f6e31e55af4c067828c8
Upstream tip: 21d1b9208ac489f8690fe8ba758dc5cd73842cf6
Git merge result: conflict

Workflows changed upstream (GITHUB_TOKEN cannot push these commits):
- .github/workflows/ci.yml
- .github/workflows/pages.yml
- .github/workflows/windows-install.yml

Paths requiring merge-conflict resolution:
- .github/workflows/ci.yml
- scripts/ci-browser.sh
- scripts/key-bar-customization-demo-regression.ts
- server/AGENTS.md
- server/codex.test.ts
- server/codex.ts
- server/index.ts
- shared/protocol.ts
- src/AGENTS.md
- src/App.tsx
- src/components/PaneTerminal.tsx
- src/lib/i18n.ja.ts
- src/lib/i18n.ko.ts
- src/lib/i18n.zh.ts

Use a human-authenticated Git credential with workflow write permission
to integrate devswha/herdr-web-ui main on a separate review branch.
Preserve docs/fork-features.md functionality and run complete GitHub CI.
