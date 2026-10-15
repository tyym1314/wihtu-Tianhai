#!/usr/bin/env bash
# Generate casino art through the local Codex CLI image tool (ChatGPT login).
# Usage: scripts/casino-art.sh <out-dir> <name> <prompt>   (writes <out-dir>/<name>.png)
set -euo pipefail
out="$1"; name="$2"; prompt="$3"
mkdir -p "$out"
cd "$out"
codex exec --skip-git-repo-check -s workspace-write \
  "Use your image generation tool to create exactly ONE image and save it in the current directory as ${name}.png (PNG). If the prompt asks for a transparent background, request a transparent background from the image tool. Reply only with the saved path. Image: ${prompt}" \
  > "${name}.log" 2>&1
test -s "${name}.png"
