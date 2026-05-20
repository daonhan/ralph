#!/bin/bash
set -eo pipefail

# Workspace = caller's cwd. Dockerfile resolution = bundled (packages/core).
# Arg validation handled by ralph-afk JS (supports --help, --print-config).
if command -v ralph-afk >/dev/null 2>&1; then
  exec ralph-afk "$@"
fi
if [ -x "./node_modules/.bin/ralph-afk" ]; then
  exec ./node_modules/.bin/ralph-afk "$@"
fi
exec npx -y @daonhan/ralph ralph-afk "$@"
