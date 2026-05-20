#!/bin/bash
set -eo pipefail

# Workspace = caller's cwd. Dockerfile resolution = bundled (packages/core).
# Arg validation handled by ralph-ghafk JS (supports --help, --print-config).
if command -v ralph-ghafk >/dev/null 2>&1; then
  exec ralph-ghafk "$@"
fi
if [ -x "./node_modules/.bin/ralph-ghafk" ]; then
  exec ./node_modules/.bin/ralph-ghafk "$@"
fi
exec npx -y @daonhan/ralph ralph-ghafk "$@"
