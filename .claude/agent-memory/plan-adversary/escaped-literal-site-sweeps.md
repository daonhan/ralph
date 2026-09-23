---
name: escaped-literal-site-sweeps
description: Plans that enumerate "every site" of a version/default via a literal grep miss regex-escaped copies (e.g. /0\.154\.0/ in test assertions)
metadata:
  type: feedback
---

When a plan lists the sites of an old value (version pin, default model ID) found by a literal grep, re-grep for the regex-escaped form (`0\.154\.0`, `opus-5\[1m\]`) as well. Test files often assert the value through a regex literal, so the plan's site list comes up short.

**Why:** 2026-09-23 Opus 5.5/GPT-6 slice. The plan named `scripts/smoke-image.test.mjs:27` but missed `:197`, which is `assert.match(DOCKERFILE, /ARG CODEX_VERSION=0\.154\.0/)`. A literal grep for `0.154.0` cannot match it. The prior five-file bump shape was copied as if it were complete.

**How to apply:** On any bump or rename slice, grep for the value both with and without regex escapes, and compare the hit count with the plan's list before accepting "N files, same shape as commit X".
