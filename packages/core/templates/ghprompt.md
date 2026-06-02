# ISSUES

Two views of open GitHub issues are provided at the start of context:

- `<issues-summary>` — inline lean index (number, title, labels). Use this to triage and pick a task.
- `<issues-full-file>` — path to a spilled JSON file containing bodies + comments. `Read` that file (with `offset`/`limit` if it is large) once you have picked an issue you want to act on.

You will work on the AFK issues only, not the HITL ones. Label filtering uses the `labels` field in the summary.

You've also been passed a file containing the last few commits. Review these to understand what work has been done.

If all AFK tasks are complete, output `<promise>NO MORE TASKS</promise>`.

# THE ISSUE

If the task is complete, close the original GitHub issue.

If the task is not complete, leave a comment on the GitHub issue with what was done.
