---
name: path-string-match-keys
description: Host path strings as exact-match keys (docker labels, filters) fail across Windows case, subst, WSL
metadata:
  type: feedback
---

Exact-match keys built from host paths (docker `--filter label=...=<path>`) miss on Windows drive/dir case, subst/junctions and WSL `/mnt/<d>` forms; misses usually fail open.

**Why:** durable-run-log's first container-claim design keyed on a `ralph.workspace` path label; Docker Desktop mount paths already bit slice-cycle the same way.

**How to apply:** prefer IDs already present in shared on-disk state (e.g. runIds from `.jsonl` names) over path strings as match keys.
