### Fixed
- A chat message to Hermes no longer joins text already typed into Hermes' input in the terminal,
  where the paste and its Enter sent both as one message. As with Claude Code, a send or a held
  message's delivery is refused while that input holds anything but Hermes' own hint, and the chat
  says so ([#1149](https://github.com/devswha/herdr-web-ui/pull/1149),
  [#859](https://github.com/devswha/herdr-web-ui/pull/859) by @RikiSanjayaa).
