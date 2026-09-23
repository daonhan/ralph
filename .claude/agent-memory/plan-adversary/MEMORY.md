# Plan-adversary memory

- [Guards vs the harness's own leftovers](guard-vs-own-leftovers.md) — a new "refuse if X exists" check must be run against every path where the harness itself leaves X behind
- [Seq advanced after fsync](seq-after-fsync-poisons-log.md) — a write that lands but whose fsync throws duplicates seq; "warn and continue" then hides every later record from readers
- [Path strings as match keys](path-string-match-keys.md) — docker labels/filters keyed on host paths miss on Windows case, subst, WSL /mnt; key on IDs the shared files already carry
- [Escaped-literal site sweeps](escaped-literal-site-sweeps.md) — literal grep for a pin/default misses regex-escaped test copies (`/0\.154\.0/`); grep both forms
- [Cache volume shadows new image](cache-volume-shadows-new-image.md) — new image doesn't reach a non-empty ralph-*-cli volume; failed update runs the stale CLI
- Check executable verification recipes against actual interfaces and import-time configuration; plausible snippets can fail before testing the feature or exercise a different target than the evidence names.
