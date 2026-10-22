### Fixed
- A damaged or unreadable shared preferences or read-finish file is no longer lost to the next
  change. Reading never touches it; the first change moves the damaged file, byte for byte, to
  `preferences.json.bad` or `seen.json.bad` (private to you, the latest damaged copy only), a file
  repaired by hand while the server runs is kept with the change added to it, and a file that
  cannot be read or set aside is not written over, so the change fails instead.
