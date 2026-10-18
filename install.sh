#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
stamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="$codex_home/backups/codex-unified-router-$stamp-$$"
service_label="com.mirza.codex-unified-router"
platform="$(uname -s)"
launch_agent=""
linux_service="codex-unified-router.service"
linux_unit=""
router_dir="$codex_home/unified-router"
router_file="$router_dir/router.mjs"
router_env="$router_dir/openrouter.env"
force=0
service=1

case "$platform" in
  MINGW*|MSYS*|CYGWIN*)
    printf 'Native Windows uses the PowerShell installer: install.ps1\n' >&2
    exit 2
    ;;
esac

for argument in "$@"; do
  case "$argument" in
    --force) force=1 ;;
    --no-service) service=0 ;;
    *)
      printf 'Usage: %s [--force] [--no-service]\n' "$0" >&2
      exit 2
      ;;
  esac
done

for command_name in codex jq node; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command_name" >&2
    exit 1
  fi
done

if [[ -z "${OPENROUTER_API_KEY:-}" ]] && [[ ! -f "$router_env" ]]; then
  printf 'OpenRouter is not configured. Export OPENROUTER_API_KEY before installing, or create %s with mode 600.\n' "$router_env" >&2
  exit 1
fi

existing_config="$codex_home/config.toml"
managed=0
if [[ -f "$existing_config" ]] && grep -q '# BEGIN codex-unified-router managed keys' "$existing_config"; then
  managed=1
fi

if [[ "$force" -eq 0 ]] && [[ -f "$existing_config" ]] && [[ "$managed" -eq 0 ]]; then
  printf 'An existing Codex configuration was found in %s.\n' "$codex_home" >&2
  printf 'The installer can merge its managed settings while preserving other sections, but requires --force for the first conversion.\n' >&2
  exit 2
fi

mkdir -p "$codex_home" "$backup_dir" "$router_dir"
chmod 700 "$router_dir" "$backup_dir"

for existing_file in config.toml deepseek.config.toml models.json; do
  if [[ -f "$codex_home/$existing_file" ]]; then
    cp -p "$codex_home/$existing_file" "$backup_dir/$existing_file"
  fi
done

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/codex-unified-router.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

codex debug models --bundled > "$tmp_dir/bundled-models.json"

node "$repo_dir/scripts/build-catalog.mjs" \
  --bundled "$tmp_dir/bundled-models.json" \
  --catalog-dir "$repo_dir/catalog" \
  --instructions "$repo_dir/prompts/deepseek-instructions.md" \
  --persistent "$repo_dir/prompts/deepseek-persistent.md" \
  --output "$tmp_dir/models.json"

node "$repo_dir/scripts/prepare-credentials.mjs" "$router_env"
node "$repo_dir/scripts/merge-config.mjs" "$existing_config" "$codex_home" "$tmp_dir/config.toml" "$router_env"

jq -e '.models[] | select(.slug == "deepseek/deepseek-v4.1-flash-1017") | .context_window == 960000' \
  "$tmp_dir/models.json" >/dev/null

install -m 600 "$tmp_dir/config.toml" "$codex_home/config.toml"
install -m 600 "$tmp_dir/models.json" "$codex_home/models.json"
install -m 600 "$repo_dir/router/unified-router.mjs" "$router_file"

if [[ -f "$codex_home/deepseek.config.toml" ]]; then
  mv "$codex_home/deepseek.config.toml" "$backup_dir/deepseek.config.toml.retired"
fi

wait_for_router() {
  local healthy=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25; do
    if curl --silent --fail --max-time 1 http://127.0.0.1:18766/health 2>/dev/null | jq -e '.ok == true and .openai == true and .openrouter == true and .clientAuth == true' >/dev/null; then
      healthy=1
      break
    fi
    sleep 0.2
  done
  [[ "$healthy" -eq 1 ]]
}

systemd_environment_line() {
  local name="$1"
  local value="$2"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf 'Environment="%s=%s"\n' "$name" "$value"
}

systemd_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

print_manual_start() {
  printf 'Automatic router startup was not configured. Start it manually with:\n' >&2
  printf '  CODEX_ROUTER_ENV_FILE=%q CODEX_MODEL_CATALOG=%q CODEX_ROUTER_PORT=18766 node %q\n' \
    "$router_env" "$codex_home/models.json" "$router_file" >&2
}

if [[ "$service" -eq 1 ]]; then
  case "$platform" in
    Darwin)
      if ! command -v launchctl >/dev/null 2>&1; then
        print_manual_start
      else
        launch_agent="$HOME/Library/LaunchAgents/$service_label.plist"
        mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
        cat > "$launch_agent" <<EOF_PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$service_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$router_file</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_ROUTER_ENV_FILE</key>
    <string>$router_env</string>
    <key>CODEX_MODEL_CATALOG</key>
    <string>$codex_home/models.json</string>
    <key>CODEX_ROUTER_PORT</key>
    <string>18766</string>
    <key>CODEX_ROUTER_STRUCTURED_MODEL</key>
    <string>gpt-6-astra</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/codex-unified-router.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/codex-unified-router.error.log</string>
</dict>
</plist>
EOF_PLIST

        launchctl bootout "gui/$(id -u)" "$launch_agent" >/dev/null 2>&1 || true
        launchctl bootstrap "gui/$(id -u)" "$launch_agent"
        launchctl kickstart -k "gui/$(id -u)/$service_label"

        if ! wait_for_router; then
          printf 'The unified router was installed but did not become healthy. Check %s.\n' "$HOME/Library/Logs/codex-unified-router.error.log" >&2
          exit 1
        fi
      fi
      ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
        linux_unit="$HOME/.config/systemd/user/$linux_service"
        node_bin="$(command -v node)"
        mkdir -p "$(dirname "$linux_unit")"
        {
          printf '[Unit]\n'
          printf 'Description=Codex Unified Router\n'
          printf 'After=network-online.target\n\n'
          printf '[Service]\n'
          printf 'Type=simple\n'
          systemd_environment_line CODEX_ROUTER_ENV_FILE "$router_env"
          systemd_environment_line CODEX_MODEL_CATALOG "$codex_home/models.json"
          systemd_environment_line CODEX_ROUTER_PORT 18766
          systemd_environment_line CODEX_ROUTER_STRUCTURED_MODEL gpt-6-astra
          printf 'ExecStart=%s %s\n' "$(systemd_quote "$node_bin")" "$(systemd_quote "$router_file")"
          printf 'Restart=always\n'
          printf 'RestartSec=2\n\n'
          printf '[Install]\n'
          printf 'WantedBy=default.target\n'
        } > "$linux_unit"

        systemctl --user daemon-reload
        systemctl --user enable "$linux_service"
        systemctl --user restart "$linux_service"

        if ! wait_for_router; then
          printf 'The unified router was installed but did not become healthy. Check:\n' >&2
          printf '  journalctl --user -u %s\n' "$linux_service" >&2
          exit 1
        fi
      else
        print_manual_start
      fi
      ;;
    *)
      print_manual_start
      ;;
  esac
fi

printf 'Installed the Codex unified router in %s\n' "$codex_home"
printf 'Backups: %s\n' "$backup_dir"
printf '\nMain thread, OpenAI:  codex -m gpt-6-astra\n'
printf 'Main thread, DeepSeek: codex -m deepseek/deepseek-v4.1-flash-1017\n'
printf '\nIn an existing session, child threads may use the same model names through spawn_agent model overrides.\n'
printf 'Restart Codex windows created before this install; they keep the provider they were started with.\n'
