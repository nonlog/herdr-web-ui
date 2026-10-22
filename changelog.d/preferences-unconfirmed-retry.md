### Fixed
- When the server cannot save a shared setting or pin, Settings now says the change is not on the
  server yet, that reloading or closing the page can undo it, and offers Retry. After three failed
  saves in a row the browser resends less often (after a minute, then up to every five minutes)
  until you press Retry or the connection reopens, and edits made meanwhile are kept. A late resend
  of a refused change no longer overwrites a newer value another device saved meanwhile, while a
  setting you pick again after the refusal still wins. While the connection is lost it waits for it
  to come back instead of resending, and a connection the browser gives up on (for example a proxy
  error while the server restarts) is opened again, so alerts and other devices' changes no longer
  stop arriving until a reload.
