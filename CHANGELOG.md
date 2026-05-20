# Changelog

All notable changes to the Ralph monorepo are recorded here. Entries are grouped
by component and, within a release, by Conventional Commit type (Features, Bug
Fixes, Performance Improvements, Dependencies, …). This file is generated and
amended by [release-please](https://github.com/googleapis/release-please); new
release sections are prepended above the baseline below. See `RELEASING.md` for
the release process and commit conventions.

## ralph-core 0.1.1 (baseline)

Seed entry for the version already published to npm as `@daonhan/ralph-core@0.1.1`
before release-please was adopted. release-please proposes the next version from
this baseline based on Conventional Commits landed since.

### Features

- Iteration loop, docker runner, template renderer, and stage registry for the
  Claude Code AFK orchestration harness.

### Continuous Integration

- Drop arm64 and npm provenance; bump the sandbox image .NET SDK to 10.

## ralph 0.1.0 (baseline)

Seed entry for the version already published to npm as `@daonhan/ralph@0.1.0`
before release-please was adopted. The CLI is versioned independently of
`ralph-core`; its entries always appear under their own `ralph` heading.

### Features

- CLI exposing the `ralph-afk` (plan/PRD loop) and `ralph-ghafk`
  (GitHub-issue loop) bin entries, depending on `@daonhan/ralph-core`.
