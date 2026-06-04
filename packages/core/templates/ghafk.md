<commits>

!?`git log -n 5 --format="%H%n%ad%n%B---" --date=short|||No commits found`

</commits>

<issues-summary>

`gh issue list --state open --limit 50 --json number,title,labels`

</issues-summary>

<issues-full-file>

Full issue bodies + comments spilled to: @spill?:issues.json=`gh issue list --state open --limit 50 --json number,title,body,labels,comments|||[]`

Read that file with `Read` (use `offset`/`limit` if it is large) to get bodies and comments before picking a task. The `<issues-summary>` block above is the lean index for triage.

</issues-full-file>

@include:ghprompt.md
