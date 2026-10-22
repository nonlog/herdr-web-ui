### Fixed
- `GET /api/pane/read` takes `lines` only as plain decimal digits from 0 to 4294967295 and refuses
  any other value (blank, signed, fractional, exponent or too large) with 400 `invalid_lines`
  instead of passing it to herdr; a blank value is no longer read as zero. Every count herdr
  takes still goes through unchanged.
