---
name: seq-after-fsync-poisons-log
description: Append-only logs whose writer advances seq only after fsync corrupt the reader's view on a failed fsync or partial write
metadata:
  type: feedback
---

If an append-only writer advances `seq` only after fsync, a write that lands but whose fsync throws (or a partial write) makes the next append duplicate or fuse a line; strict readers stop there and never see later records.

**Why:** durable-run-log's "heartbeat failure warns and continues" would have hidden `run.ended` from supervisors.

**How to apply:** when a plan tolerates append failures, ask what bytes are on disk after the throw and require seq/brokenness handling plus a read-back test.
