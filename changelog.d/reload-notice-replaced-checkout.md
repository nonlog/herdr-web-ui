### Fixed
- When the source checkout a managed server runs from is replaced under it (`herdr plugin install`
  run again, or `git pull` and a build), the app now tells you to restart herdr web ui on the PC
  instead of showing "App updated" and **Reload app**, which never went away because a reload
  loaded the same build again. The notice shows on the page's next status read, links to the
  restart commands, and goes away once the server restarts.
