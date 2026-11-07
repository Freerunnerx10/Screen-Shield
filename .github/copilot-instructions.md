# Repository Instructions

- For every behavior, UI, native-backend, packaging, or dependency change, add a concise user-facing entry under `## [Unreleased]` in the root `CHANGELOG.md` before finishing the change.
- When preparing a release, move the shipped `Unreleased` entries into a dated, versioned section and leave `Unreleased` ready for the next changes.
- Categorize entries under `### Added`, `### Changed`, `### Fixed`, or `### Removed`; keep the changelog edit in the same change as the implementation.
- Do not bump version numbers or convert `Unreleased` into a numbered release unless the user asks to prepare or publish a release.
- Documentation-only edits do not need a changelog entry unless they describe a user-visible behavior change.