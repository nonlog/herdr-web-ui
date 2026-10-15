### Fixed
- With herdr 0.9.4 or later, opening a terminal on a second device no longer types stray
  characters such as `1016;2$y1;2c` into the pane, and a terminal is no longer reported ready
  before its attach has settled: the app answers herdr's attach-time terminal queries itself
  instead of replaying them to every browser.
