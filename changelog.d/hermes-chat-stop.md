### Fixed
- **Stop** in a Hermes pane's chat interrupts the running turn: it sends Hermes one Ctrl+C, the key
  Hermes interrupts with, instead of an Escape Hermes ignores. It does so only while Hermes' own input
  row shows a running turn, and once per turn, since Ctrl+C quits an idle Hermes and a second one
  force-quits it ([#856](https://github.com/devswha/herdr-web-ui/issues/856),
  [#859](https://github.com/devswha/herdr-web-ui/pull/859) by @RikiSanjayaa).
