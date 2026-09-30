# Practical review checklist

Use this checklist for Ralph changes alongside [CONTRIBUTING.md](../CONTRIBUTING.md).
Review the final diff and the stated behavior, rather than treating checked boxes
as proof. Apply the items relevant to the change and explain omissions.

## Behavior and scope

- [ ] The description identifies the concrete trigger, resulting behavior and
      reason for the change; an example shows before/after behavior when useful.
- [ ] The diff preserves unrelated local edits and stays within the requested
      scope. Remaining limitations, compatibility risks and follow-ups are clear.
- [ ] Core stays ESM with `.js` imports; CLI stays plain JS without a build step.
- [ ] The first stage remains the gate, reviewer never gates, and provider
      differences stay in adapters rather than the loop or renderer.
- [ ] Changed contracts preserve run-log durability/schema, live-run claims,
      container cleanup, history ownership and the template substitution order.

## Safety and shipped behavior

- [ ] Host-shell template commands are static; user/issue/commit content and
      history cannot become host commands. Windows fallbacks are appropriate.
- [ ] Changes to mounts, credentials, Docker socket access or bypass permissions
      match [SECURITY.md](../SECURITY.md). Secrets and author identities are not
      invented, overridden or exposed.
- [ ] Templates and skills still ship in the tarball, names/frontmatter remain
      valid, and contract/smoke coverage exercises any changed shipped behavior.
- [ ] Version state remains release-please-owned. Publishing changes retain the
      intended tags, artifacts and attestation flow without duplicate dispatches.

## Validation and CI

- [ ] The PR lists commands, outcomes and relevant output: **pending**, **passed**,
      **failed** or **skipped**, with reasons and limitations. Pending/skipped is
      never presented as passed. Agents ran Node tests in the background.
- [ ] Checks ran in order and stopped on failure: `git diff --check`, typecheck,
      build, workspace tests and root tests. Build preceded checks importing `dist/`.
- [ ] Relevant offline smokes ran. Image changes received the full network smoke
      before publishing; Docker checks skipped locally are recorded accurately.
- [ ] Hook/CI change classification includes deleted and renamed code, mixed
      changes, templates, skills and agent guidance; ordinary docs can skip tests.
- [ ] Changed configuration parses, documentation links resolve, automatic
      required statuses remain available and manual compatibility coverage is
      described honestly. Hosted execution is not claimed from local checks.

## Documentation and ownership

When a change affects architecture, interfaces, or invariants, update the relevant docs before finishing. Delegate the docs pass to a sub-agent.

- [ ] Relevant source-of-truth docs changed, or the PR explains why none apply.
      `AGENTS.md` and `CLAUDE.md` remain identical.
- [ ] The docs delegate changed only documentation; implementer retains red →
      green implementation and reviewer retains refactoring/defect reviews.
- [ ] The primary agent reviewed the delegate's final diff for accuracy, scope
      and links before declaring completion.
- [ ] No commit, push, merge or publish occurred without the user's authorization.
