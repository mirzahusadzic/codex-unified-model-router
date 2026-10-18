#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
input="$repo_dir/catalog/deepseek-model.json"
output="${1:-$repo_dir/catalog/deepseek-model.json}"
tmp_file="$(mktemp "${TMPDIR:-/tmp}/deepseek-catalog.XXXXXX")"
trap 'rm -f "$tmp_file"' EXIT

jq --rawfile instructions "$repo_dir/prompts/deepseek-instructions.md" \
   --rawfile persistent "$repo_dir/prompts/deepseek-persistent.md" '
     .base_instructions = $instructions
     | .model_messages.instructions_template = $instructions
     | .model_messages.persistent_instructions = $persistent
   ' "$input" > "$tmp_file"

mv "$tmp_file" "$output"
chmod 644 "$output"
trap - EXIT
