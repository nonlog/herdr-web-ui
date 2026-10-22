### Fixed
- A dragged workspace order no longer jumps back while its moves are still landing: a roster read
  before the move, a cached roster or another PC's update cannot undo it, and the first roster
  read after the move (another browser's later order included) replaces it. A remote PC does this
  once its bridge is updated to the next release; until then it keeps the earlier behaviour.
