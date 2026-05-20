#!/bin/bash
set -eo pipefail

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: $0 <plan-and-prd> <iterations>"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export RALPH_WORKSPACE="$(cd "$SCRIPT_DIR/.." && pwd)"
export RALPH_DOCKER_CONTEXT="$SCRIPT_DIR"

cd "$RALPH_WORKSPACE"

exec npx --no-install @daonhan/ralph ralph-afk "$1" "$2" 2>/dev/null \
  || exec npx -y @daonhan/ralph ralph-afk "$1" "$2"
