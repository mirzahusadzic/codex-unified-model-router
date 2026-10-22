#!/usr/bin/env bash
set -euo pipefail

codex_home="${CODEX_HOME:-$HOME/.codex}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)"
service_label="com.mirza.codex-unified-router"
linux_service="codex-unified-router.service"
platform="$(uname -s)"
check_service=1

case "$platform" in
  MINGW*|MSYS*|CYGWIN*)
    printf 'Native Windows uses the PowerShell verifier: platform/windows/verify-install.ps1\n' >&2
    exit 2
    ;;
esac

for arg in "$@"; do
  case "$arg" in
    --no-service) check_service=0 ;;
    -h|--help) exec node "$script_dir/../install.mjs" --help ;;
    *)
      printf 'Unknown option: %s\nRun '\''node install.mjs --help'\'' for usage.\n' "$arg" >&2
      exit 2
      ;;
  esac
done

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

node "$script_dir/verify-catalog.mjs" "$codex_home/models.json"

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
node "$script_dir/verify-catalog.mjs" --report "$codex_home/models.json"
