### Fixed
- Pairing a device, renaming or revoking one, and the web push key and subscriptions are now
  flushed to disk before they replace the previous file, so a crash or power cut right after the
  change is much less likely to bring back a revoked device or make every phone subscribe to
  alerts again. How much survives a power cut still depends on the disk and filesystem honouring
  the flush; on Windows the folder itself is not flushed.
