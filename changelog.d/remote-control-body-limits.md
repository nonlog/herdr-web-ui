### Fixed
- An oversized or unreadable answer from another PC's bridge is now refused at a fixed size
  instead of being held whole in memory: connecting, refreshing and the PC proxy stop reading it,
  report a short error in the user's language that repeats none of it, and a watching device
  never gets a prompt that could not be redacted.
