<!--
Thanks for contributing to Ralph! A few notes:
- Commits use Conventional Commits (the type + path drive release-please). See RELEASING.md §3.
- Run the local verify before pushing (see below). CI runs the same on every PR.
-->

## What & why

<!-- What does this change and why? Link any issue: Closes #NNN -->

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor / clean-up (no behavior change)
- [ ] Docs
- [ ] CI / build / release

## Verification

- [ ] `pnpm -r build`
- [ ] `pnpm -r typecheck`
- [ ] `pnpm -r test`
- [ ] `pnpm test` (root `node --test`)
- [ ] Smoke scripts where relevant (`node scripts/smoke-templates.mjs`, `smoke-render.mjs`)

## Notes for reviewers

<!-- Anything that needs extra eyes: behavior changes, template/playbook edits, security-relevant surfaces. -->
