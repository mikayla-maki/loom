---
name: release-notes
description: House style for writing release notes and changelogs. Use when
  drafting, reviewing, or editing release notes, changelog entries, or
  version announcements.
---

# Release notes style

Follow these conventions for every release note:

- Lead with the user-visible change, not the implementation.
- One sentence per change; start with a verb ("Added", "Fixed", "Removed").
- Group entries under `### Added`, `### Changed`, `### Fixed`, `### Removed`.
- Breaking changes get a `**BREAKING:**` prefix and a migration hint.
- No internal ticket numbers; link PRs as `(#123)`.

See [references/example.md](references/example.md) for a worked example.
