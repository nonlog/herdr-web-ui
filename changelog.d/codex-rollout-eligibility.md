### Fixed
- The chat and the session history now apply one rule to Codex rollouts: a subagent's rollout (one
  naming a parent thread or an agent role), an exec run's, or one whose ids are null or contradict
  its file name is no longer read as a pane's conversation or offered to resume, while older
  rollouts without those fields still are. A rollout whose first line is longer than the chat or
  the history reads is left out instead of read unchecked.
