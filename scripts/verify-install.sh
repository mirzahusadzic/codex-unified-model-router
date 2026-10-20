#!/usr/bin/env bash
set -euo pipefail

codex_home="${CODEX_HOME:-$HOME/.codex}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
service_label="com.mirza.codex-unified-router"
linux_service="codex-unified-router.service"
platform="$(uname -s)"
check_service=1

case "$platform" in
  MINGW*|MSYS*|CYGWIN*)
    printf 'Native Windows uses the PowerShell verifier: scripts/verify-install.ps1\n' >&2
    exit 2
    ;;
esac

if [[ "${1:-}" == "--no-service" ]]; then
  check_service=0
elif [[ -n "${1:-}" ]]; then
  printf 'Usage: %s [--no-service]\n' "$0" >&2
  exit 2
fi

test -f "$codex_home/config.toml"
test -f "$codex_home/unified-openrouter.config.toml"
test -f "$codex_home/models.json"
test -f "$codex_home/unified-router/router.mjs"
node "$script_dir/verify-credentials.mjs" "$codex_home"

grep -q '# BEGIN codex-unified-router managed keys' "$codex_home/config.toml"
grep -q '^model_provider = "unified"$' "$codex_home/config.toml"
grep -q '^\[model_providers\.unified\]$' "$codex_home/config.toml"
grep -q '^requires_openai_auth = true$' "$codex_home/config.toml"
grep -q '^supports_websockets = false$' "$codex_home/config.toml"
grep -q 'const structuredFallbackModel = process.env.CODEX_ROUTER_STRUCTURED_MODEL || '\''gpt-6-astra'\''' "$codex_home/unified-router/router.mjs"

jq -e '.models[] | select(.slug == "deepseek/deepseek-v4.1-flash-1017") | .context_window == 960000 and .max_context_window == 960000' \
  "$codex_home/models.json" >/dev/null

jq -e '.models[] | select(.slug == "deepseek/deepseek-v4.1-flash-1017") | .base_instructions == .model_messages.instructions_template' \
  "$codex_home/models.json" >/dev/null

if jq -r '.models[] | select(.slug == "deepseek/deepseek-v4.1-flash-1017") | .base_instructions, .model_messages.persistent_instructions' \
  "$codex_home/models.json" | grep -E 'update_plan|send_user_message_async|clock\.sleep|update_up_next'; then
  printf 'DeepSeek prompt still references unavailable tools.\n' >&2
  exit 1
fi

if jq -r '.models[] | select(.slug == "deepseek/deepseek-v4.1-flash-1017") | .base_instructions, .model_messages.persistent_instructions' \
  "$codex_home/models.json" | grep -Ei 'adares|mirzahusadzic|2550|rca catalyst|cogx|cetasol|volvo|tendora|intentropia|egemma'; then
  printf 'DeepSeek prompt contains project-specific residue.\n' >&2
  exit 1
fi

if [[ "$check_service" -eq 1 ]]; then
  node "$script_dir/verify-health.mjs" "$codex_home/unified-router/router.mjs" http://127.0.0.1:18766/health
  case "$platform" in
    Darwin)
      if ! launchctl print "gui/$(id -u)/$service_label" >/dev/null; then
        printf 'The launch agent is not loaded.\n' >&2
        exit 1
      fi
      ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
        if ! systemctl --user is-active --quiet "$linux_service"; then
          printf 'The systemd user service is not active: %s\n' "$linux_service" >&2
          exit 1
        fi
      else
        printf 'Warning: systemd --user is unavailable; the router is running but automatic startup could not be verified.\n' >&2
      fi
      ;;
  esac
fi

printf 'Install looks valid.\n'
printf 'Default main model: %s\n' "$(sed -n 's/^model = "\(.*\)"$/\1/p' "$codex_home/config.toml" | head -1)"
printf 'Selectable models: gpt-6-astra, deepseek/deepseek-v4.1-flash-1017, and the rest of the catalog.\n'
