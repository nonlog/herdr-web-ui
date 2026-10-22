### Added
- Claude Code, grok and Antigravity messages in Chat offer Rewind in terminal: it sends nothing,
  preserves your draft and opens the pane's terminal with a hint to run the agent's own `/rewind`.
  Chat follows the native conversation when the agent records its new branch.
- Chat sends wait while Claude Code's rewind dialog is open in the terminal, so a message cannot
  land in the dialog's own text field.
