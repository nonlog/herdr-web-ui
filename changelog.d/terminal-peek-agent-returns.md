### Changed
- After a terminal command sent from Chat, Codex, omp, pi, gjc, OmO, Hermes (classic CLI), Devin,
  agy and Grok bring the chat back by themselves when you close the picker or panel it opened,
  once the agent's own empty input row is back on the screen. Only the commands each agent was
  recorded doing that for count (Codex's `/permissions`, omp's `/settings`, Grok's `/resume` and
  the like); print forms, toggles, editor handoffs, Codex's `/side` and `/btw`, OpenCode and
  anything unrecorded still return by hand.

### Fixed
- Going back to the chat while a terminal command's screen is still open (Claude Code's `/btw`
  answer, a picker left up) no longer lets the next message from the message box be typed into
  that screen and do nothing, for Claude Code and the agents above (not OpenCode): the composer
  says the command is still open in the terminal, with Show terminal, and Send (or a queued
  message's Send now) keeps the message until the screen closes or you choose Send anyway.
