#!/usr/bin/env bash
# The browser lane of CI: the lockfile's Playwright Chromium, then the scripts that drive it.
set -euo pipefail
# CI's runner image has none of Chromium's system libraries; a PC is not asked for sudo
if [ -n "${CI:-}" ]; then
  # as root, so a timed-out attempt's apt can be killed (an unprivileged timeout cannot SIGKILL root's apt)
  sudo bash scripts/ci-bounded-retry.sh 300 "$(command -v bun)" node_modules/playwright-core/cli.js install-deps chromium
  bun node_modules/playwright-core/cli.js install chromium
else
  bun node_modules/playwright-core/cli.js install chromium
fi
CHROME_PATH="$(bun -e 'console.log(require("playwright-core").chromium.executablePath())')"
export CHROME_PATH
# The demo scripts below all show the same client: it is built once here and each copies it
# (scripts/demo-build.ts), instead of each building it again.
HERDR_DEMO_BUILD="$(mktemp -d)"
export HERDR_DEMO_BUILD
trap 'rm -rf "$HERDR_DEMO_BUILD"' EXIT
bun scripts/demo-build.ts "$HERDR_DEMO_BUILD"
bun scripts/windows-lens-browser-qa.ts
bun scripts/ui-regression.ts
bun scripts/sticky-modifiers-regression.ts
bun scripts/key-bar-customization-demo-regression.ts
bun scripts/settings-pages-demo-regression.ts
bun scripts/chat-history-browser-qa.ts
bun scripts/math-browser-qa.ts
bun scripts/file-viewer-regression.ts
bun scripts/keyboard-viewport-regression.ts
bun scripts/file-viewer-mobile-regression.ts
bun scripts/droplet-demo-regression.ts
bun scripts/chat-greeting-demo-regression.ts
bun scripts/composer-fit-demo-regression.ts
bun scripts/held-rows-demo-regression.ts
bun scripts/sidebar-activity-demo-regression.ts
bun scripts/prompt-dock-demo-regression.ts
bun scripts/machine-dialog-regression.ts
bun scripts/machine-conflict-regression.ts
