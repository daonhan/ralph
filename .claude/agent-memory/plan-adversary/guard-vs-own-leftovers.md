---
name: guard-vs-own-leftovers
description: Review check for new refusal/claim guards — enumerate paths where the harness itself leaves the guarded resource behind
metadata:
  type: feedback
---

A new "refuse while X exists" guard must be checked against every normal path where the harness itself leaves X behind (e.g. grace-timer and decoder-failure kills that only kill the docker CLI and orphan a hung container).

**Why:** durable-run-log's container claim would have made one grace-timer firing block every later launch with exit 75 until a manual `docker stop`.

**How to apply:** for any claim/lock/refusal plan, grep the code for kill/abandon paths of the guarded resource and require cleanup or an exemption rule.
