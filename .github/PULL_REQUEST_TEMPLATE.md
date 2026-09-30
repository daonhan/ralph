<!--
Thanks for contributing to Ralph! A few notes:
- Commits use Conventional Commits (the type + path drive release-please). See RELEASING.md §3.
- Use CONTRIBUTING.md and docs/REVIEW_CHECKLIST.md. Ordinary docs-only PRs retain
  a CI status while skipping compiler/tests; agent guidance/templates/skills run checks.
-->

## Behavior and reason

<!-- Describe the concrete trigger and resulting behavior, why it is needed,
and before/after behavior where useful. Link any issue: Closes #NNN. -->

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor / clean-up (no behavior change)
- [ ] Docs
- [ ] CI / build / release

## Verification

<!-- Replace each status with pending / passed / failed / skipped.
Include useful results and reasons for skipped checks. Build before root tests.
Agents run Node tests in the background without visible terminal windows. -->

| Check                                         | Status  | Results or reason |
| --------------------------------------------- | ------- | ----------------- |
| `git diff --check`                            | pending |                   |
| `pnpm -r typecheck`                           | pending |                   |
| `pnpm -r build`                               | pending |                   |
| `pnpm -r test`                                | pending |                   |
| `pnpm test`                                   | pending |                   |
| Relevant offline/Docker/image smokes          | pending |                   |
| Configuration and changed documentation links | pending |                   |

## Documentation

<!-- Name the updated source-of-truth docs or explain why no docs change applies. -->

- [ ] Architecture, interfaces and invariants have matching documentation.
- [ ] For agent work affecting these contracts, a sub-agent completed the docs
      pass and the primary agent reviewed the changes before completion.
- [ ] Implementation and reviewer ownership remained with their original roles.

## Limitations and reviewer focus

<!-- State remaining limitations, unverified environments, compatibility/security
risks and follow-ups. Highlight areas needing review; do not claim hosted CI or
live publishing was verified by local checks. -->
