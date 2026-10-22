### Fixed
- An omp pane started with an absolute `--cwd` shows its chat when herdr names no session file
  and the directory herdr reports is not omp's own, such as the shell's or a symlink's real path:
  the session is still looked up in the directory herdr reports first, then under that `--cwd`.
