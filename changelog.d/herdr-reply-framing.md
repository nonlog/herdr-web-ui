### Fixed
- A malformed, oversized or misaddressed answer from herdr now fails only the request it answers,
  with a clear error, instead of hanging until the timeout, growing the server's memory or being
  taken as another request's answer; event subscriptions report such a frame and close.
