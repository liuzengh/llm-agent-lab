#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

printf '/help\n/exit\n' | npm start

if [[ -z "${OPENAI_BASE_URL:-}" || -z "${OPENAI_API_KEY:-}" || -z "${MODEL_NAME:-}" ]]; then
  echo "Skipping provider-backed interaction smoke: OPENAI_BASE_URL, OPENAI_API_KEY, and MODEL_NAME are required."
  exit 0
fi

for example in examples/descriptions/*.txt; do
  npm start -- /plan "$(cat "$example")" --yes
done

description="$(cat examples/descriptions/repo-analysis.txt)"
npm start -- /workflow "$description" --yes

if node --input-type=module -e \
  "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync('.workflow/config.json')); process.exit(c.mcpServers?.some(s => s.id === 'echo') ? 0 : 1)" \
  2>/dev/null; then
  npm start -- /workflow "$(cat examples/descriptions/mcp-lookup.txt)" --yes
fi

printf '/doctor\n/exit\n' | npm start

test -d .workflow/runs
test -n "$(ls -A .workflow/runs)"

if [[ "${WORKFLOW_SMOKE_BUILD_SANDBOX:-0}" == "1" ]]; then
  printf '/sandbox build\n/exit\n' | npm start
fi
