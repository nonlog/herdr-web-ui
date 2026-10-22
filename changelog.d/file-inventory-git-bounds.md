### Fixed
- File search and path lookup no longer run a repository's fsmonitor hook, follow Git variables
  the server was started with, or wait on a Git listing that never ends: a listing past 16 MiB
  or 3 seconds, or one cut off mid-name, falls back to the folder walk.
- **Files → Changes** no longer runs a program named `false` found on `PATH` with Git 2.35 or
  older, and reads the repository asked about even when the server was started with
  `GIT_COMMON_DIR` set.
