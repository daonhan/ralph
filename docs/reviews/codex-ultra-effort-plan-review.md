# Codex Ultra effort: plan-adversary review

Date: 2026-09-22. Scope: [PRD](../prd/codex-ultra-effort.md) and [implementation plan](../plans/codex-ultra-effort.md), against baseline `4e90253992cab3126cc8f7569243a420b2ce6cac`.

## Review procedure

An independent read-only Codex subagent followed the repository's [plan-adversary instructions](../../.claude/agents/plan-adversary.md), read its [project memory](../../.claude/agent-memory/plan-adversary/MEMORY.md) and all three linked failure-mode notes, and checked the source, tests, and installed slice-cycle 0.8.0 worker contract v1. The repository agent's Claude-specific `model: opus` frontmatter was not used as a Codex model setting. The reviewer did not modify files or start implementation.

## Pass 1

**Verdict: go after the fixes below were folded during review. No Critical findings.**

| Finding                                                                                     | Verified resolution                                                                                                                                                                |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Smoke descriptor and workspace setup could fail before exercising Ultra.                    | Use the actual `StageContainer` shape `{ name, runId }`, initialize the scratch Git repository, and set `RALPH_IMAGE` before dynamically importing the runner.                     |
| A measured CLI version could differ from the executing one because of updates/cache mounts. | Pin the image by immutable ID and disable the update/cache mount for the smoke only. Record that image's client version, require the marker and terminal event, and check cleanup. |
| Generic automatic-delegation wording omitted the local CLI qualification.                   | Both artifacts distinguish selecting Ultra from proactive delegation and carry the local-client direct-request/project-instruction qualification from the official docs.           |
| Unescaped effort separators broke the U3 Markdown table.                                    | Use comma-separated values; verify all table rows retain two columns.                                                                                                              |
| Product-doc delegation could be attributed to the coordinator.                              | State explicitly that Ralph's implementer delegates product-doc edits; the slice-cycle coordinator reviews and sends repairs back through Ralph.                                   |

The reviewer confirmed coverage for literal effort validation, precedence, inherited-field omission, exact argv, diagnostic output, durable errors, a HEAD-moving two-stage run, the known CRLF baseline, and the plugin's issue-derived budget/queue/authority rules.

## Final pass 2

**Final verdict: go. Critical: none. Warning: none.**

The same independent adversary re-read the final artifact pair and this review record, verified the implementation-owner clarification, and independently syntax-checked the smoke recipe without executing it. It confirmed the real interfaces, import-time image setting, pinned client, scratch Git setup, completion/cleanup evidence, unchanged defaults, inherited-config behavior, baseline-failure handling and separate-worker authority. All four memory patterns were checked; no further durable pattern or blocker was found. This concludes the two-pass review.

## Known failure-mode cross-check

- **Guards versus own leftovers:** no new refusal guard; the smoke names its own container and checks cleanup, including abandonment.
- **Sequence after failed fsync:** no log writer/schema change; existing durable invalid-tuning behavior is preserved.
- **Path strings as match keys:** no new host-path identity key; use generated container identity and the existing worker checkpoint contract.

The new durable lesson is to verify executable plan recipes against actual interfaces and import-time configuration before calling them a validation gate.

## Evidence limits

This is a plan review, not an implementation review. Planning verified local Codex 0.154.0 catalog metadata, documentation consistency, Markdown table/link structure, and JavaScript syntax of the disposable smoke recipe. The model smoke, feature tests, full candidate-head gate, and independent implementation/security reviews remain acceptance work for the separate slice-cycle task. No GitHub issue, worker checkpoint, BUILD, PR, or merge was created by this planning task.
