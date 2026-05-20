<commits>

!`git log -n 5 --format="%H%n%ad%n%B---" --date=short 2>/dev/null || echo "No commits found"`

</commits>

<issues>

!`gh issue list --state open --json number,title,body,comments 2>/dev/null || echo "[]"`

</issues>

!`cat ralph/ghprompt.md`
