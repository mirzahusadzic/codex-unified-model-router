#!/usr/bin/env bash
set -euo pipefail

codex_home="${CODEX_HOME:-$HOME/.codex}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)"
# shellcheck source=service-pids.sh
source "$(dirname "${BASH_SOURCE[0]}")/service-pids.sh"
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

for file in "$codex_home/config.toml" "$codex_home/unified-openrouter.config.toml" \
    "$codex_home/models.json" "$codex_home/unified-router/router.mjs"; do
  if [[ ! -f "$file" ]]; then
    printf 'Missing required file: %s\n' "$file" >&2
    exit 1
  fi
done
node "$script_dir/verify-credentials.mjs" "$codex_home"
node "$script_dir/verify-router.mjs" "$codex_home"

# The last argument is the expected text; the others are grep options.
require_config() {
  if ! grep -q "$@" "$codex_home/config.toml"; then
    printf 'Config is missing: %s\n' "${@: -1}" >&2
    exit 1
  fi
}
require_config -F '# BEGIN codex-unified-router managed keys'
require_config -xF 'model_provider = "unified"'
require_config -xF '[model_providers.unified]'
require_config -xF 'requires_openai_auth = true'
require_config -xF 'supports_websockets = false'

node "$script_dir/verify-catalog.mjs" "$codex_home/models.json"

if [[ "$check_service" -eq 1 ]]; then
  # The router answering health must be the service's own process, not a
  # stray copy of the same code holding the port.
  health_args=("$codex_home/unified-router/router.mjs" http://127.0.0.1:18766/health)
  case "$platform" in
    Darwin)
      if ! launchctl print "gui/$(id -u)/$service_label" >/dev/null; then
        printf 'The launch agent is not loaded.\n' >&2
        exit 1
      fi
      health_args+=("--service-pid=$(service_pids "$platform" "$service_label" "$linux_service")")
      ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
        if ! systemctl --user is-active --quiet "$linux_service"; then
          printf 'The systemd user service is not active: %s\n' "$linux_service" >&2
          exit 1
        fi
        health_args+=("--service-pid=$(service_pids "$platform" "$service_label" "$linux_service")")
      else
        printf 'systemd --user is unavailable, so automatic startup could not be verified. If the router was installed without a service, run: node install.mjs --verify --no-service\n' >&2
        exit 1
      fi
      ;;
  esac
  node "$script_dir/verify-health.mjs" "${health_args[@]}"
  node "$script_dir/codex-daemon.mjs" --verify "$codex_home"
fi

printf 'Install looks valid.\n'
printf 'Default main model: %s\n' "$(sed -n 's/^model = "\(.*\)"$/\1/p' "$codex_home/config.toml" | head -1)"
node "$script_dir/verify-catalog.mjs" --report "$codex_home/models.json"
