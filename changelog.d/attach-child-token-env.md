### Fixed
- The terminal attach process and its Node host no longer inherit the server's `HERDR_WEB_TOKEN`
  environment variable; they keep the socket path and the rest of their environment.
