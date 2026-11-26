#!/bin/sh
# Self-installer for herdr-glass. All logic lives in install.mjs; this only
# makes sure Node.js is available. See install.mjs --help for options.
set -eu
dir=$(cd "$(dirname "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  case " $* " in
    *" --yes "*) if command -v brew >/dev/null 2>&1; then brew install node; fi ;;
  esac
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js 22.15+ is required: https://nodejs.org" >&2
    exit 1
  fi
fi
exec node "$dir/install.mjs" "$@"
