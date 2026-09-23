---
name: cache-volume-shadows-new-image
description: A fix that "ships in the new image" does not reach users whose harness-owned named volume (ralph-claude-home, ralph-codex-cli) already holds an older CLI
metadata:
  type: feedback
---

When a plan relies on a new image (a bumped CLI pin or a fresh Claude Code) to make a new default work, check the path where the update is on but fails. Docker seeds a named volume from the image only when the volume is empty. After that, the volume shadows every newer image, and a failed `claude update` / `codex update` (`|| true`) runs whatever the volume holds. Also check local non-floating tags such as `ralph-sandbox:pg17`, which `ensureImage` never re-pulls.

**Why:** 2026-09-23 Opus 5.5/GPT-6 slice. The design claimed that only `RALPH_*_UPDATE=0` with a stale image could reject the new default model. That missed the failed-update + stale-volume path and custom local images. Related: [[guard-vs-own-leftovers]]. The harness's own cached artifacts are the leftovers.

**How to apply:** For any default or pin change, enumerate: update-on + success, update-on + failure (volume version), update-off + `:latest` (re-pulled), and update-off + a pinned or local tag (never re-pulled). Require a troubleshooting line naming the symptom and the volume-rm or rebuild remedy.
