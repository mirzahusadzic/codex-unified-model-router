#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_files=()
cleanup() {
  rm -f "${tmp_files[@]}"
}
trap cleanup EXIT

# Render the shared prompts into every catalog entry routed through OpenRouter.
render_file() {
  local file="$1"
  local tmp_file
  tmp_file="$(mktemp "${TMPDIR:-/tmp}/openrouter-catalog.XXXXXX")"
  tmp_files+=("$tmp_file")
  jq --rawfile instructions "$repo_dir/prompts/openrouter-instructions.md" \
     --rawfile persistent "$repo_dir/prompts/openrouter-persistent.md" '
       def render:
         if (.slug | startswith("openrouter/") or startswith("deepseek/")) then
           .base_instructions = $instructions
           | .model_messages.instructions_template = $instructions
           | .model_messages.persistent_instructions = $persistent
         else . end;
       if type == "array" then map(render) else render end
     ' "$file" > "$tmp_file"
  mv "$tmp_file" "$file"
  chmod 644 "$file"
}

for file in "$repo_dir"/catalog/*.json; do
  render_file "$file"
done
