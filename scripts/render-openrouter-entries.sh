#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_files=()
cleanup() {
  rm -f "${tmp_files[@]}"
}
trap cleanup EXIT

render_entry() {
  local input="$1"
  local output="$2"
  local tmp_file
  tmp_file="$(mktemp "${TMPDIR:-/tmp}/openrouter-catalog.XXXXXX")"
  tmp_files+=("$tmp_file")
  jq --rawfile instructions "$repo_dir/prompts/openrouter-instructions.md" \
     --rawfile persistent "$repo_dir/prompts/openrouter-persistent.md" '
       .base_instructions = $instructions
       | .model_messages.instructions_template = $instructions
       | .model_messages.persistent_instructions = $persistent
     ' "$input" > "$tmp_file"
  mv "$tmp_file" "$output"
  chmod 644 "$output"
}

if [[ $# -gt 0 ]]; then
  render_entry "$repo_dir/catalog/deepseek-model.json" "$1"
  exit 0
fi

render_entry "$repo_dir/catalog/deepseek-model.json" "$repo_dir/catalog/deepseek-model.json"
