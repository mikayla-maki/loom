# Example release note

## v2.3.0

### Added

- Added row-set capability grants, so per-command authority no longer
  widens the whole shell (#412)

### Fixed

- Fixed catalog trimming hiding skills that were accepted at boot (#418)

### Removed

- **BREAKING:** Removed trusted paths; sessions contribute tool groups
  instead. Migrate `trustedPaths()` to `tools()`.
