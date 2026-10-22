#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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
    printf 'Native Windows uses the PowerShell installer: platform/windows/install.ps1\n' >&2
    exit 2
    ;;
esac

api_key_file=""
usage() {
  printf 'Usage: %s [--force] [--no-service] [--api-key-file <path>]\n' "$0" >&2
  exit 2
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) force=1 ;;
    --no-service) service=0 ;;
    --api-key-file)
      [[ $# -ge 2 ]] || usage
      api_key_file="$2"
      shift
      ;;
    *) usage ;;
  esac
  shift
done

restart_daemon="${CODEX_ROUTER_RESTART_DAEMON:-1}"
if [[ "$restart_daemon" != 0 && "$restart_daemon" != 1 ]]; then
  printf 'CODEX_ROUTER_RESTART_DAEMON must be 0 or 1\n' >&2
  exit 2
fi

native_models="${CODEX_ROUTER_NATIVE_MODELS:-auto}"
case "$native_models" in
  auto|show|hide) ;;
  *)
    printf 'CODEX_ROUTER_NATIVE_MODELS must be auto, show, or hide\n' >&2
    exit 2
    ;;
esac

for command_name in codex jq node; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command_name" >&2
    exit 1
  fi
done

existing_config="$codex_home/config.toml"
existing_profile="$codex_home/unified-openrouter.config.toml"

# Merging into a configuration the router does not manage yet needs consent:
# a yes at the prompt, or --force where no terminal is available. Only a real
# marker line counts as managed, never one inside a TOML string or comment.
unmanaged=()
for file in "$existing_config" "$existing_profile"; do
  if [[ -f "$file" ]] && ! node "$repo_dir/scripts/config-managed.mjs" "$file"; then unmanaged+=("$file"); fi
done
if [[ "$force" -eq 0 && ${#unmanaged[@]} -gt 0 ]]; then
  if [[ ! -t 0 ]]; then
    printf 'Existing Codex configuration found: %s\n' "${unmanaged[*]}" >&2
    printf 'Run the installer in a terminal to confirm merging into it, or pass --force. The files are backed up first.\n' >&2
    exit 2
  fi
  printf 'Existing Codex configuration found:\n' >&2
  printf '  %s\n' "${unmanaged[@]}" >&2
  printf 'The installer backs these files up, then adds its settings and keeps everything else.\n' >&2
  read -r -p 'Merge into them? [y/N] ' answer
  case "$answer" in
    [yY]|[yY][eE][sS]) force=1 ;;
    *)
      printf 'Nothing was changed.\n' >&2
      exit 2
      ;;
  esac
fi

# The OpenRouter key comes from --api-key-file, OPENROUTER_API_KEY, or the
# stored key; otherwise ask for it without echoing. It never appears in a
# command line, where other processes could read it.
prompted_key=""
if [[ -n "$api_key_file" && ! -f "$api_key_file" ]]; then
  printf 'API key file not found: %s\n' "$api_key_file" >&2
  exit 2
fi
if [[ -z "$api_key_file" && -z "${OPENROUTER_API_KEY:-}" && ! -f "$router_env" ]]; then
  if [[ ! -t 0 ]]; then
    printf 'No OpenRouter API key. Run the installer in a terminal to be prompted for it, or pass --api-key-file <path>.\n' >&2
    exit 1
  fi
  read -r -s -p 'OpenRouter API key: ' prompted_key
  printf '\n' >&2
  if [[ -z "$prompted_key" ]]; then
    printf 'No OpenRouter API key entered.\n' >&2
    exit 1
  fi
fi

mkdir -p "$codex_home" "$backup_dir" "$router_dir"
chmod 700 "$router_dir" "$backup_dir"

for existing_file in config.toml deepseek.config.toml unified-openrouter.config.toml models.json; do
  if [[ -f "$codex_home/$existing_file" ]]; then
    cp -p "$codex_home/$existing_file" "$backup_dir/$existing_file"
  fi
done

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/codex-unified-router.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

codex debug models --bundled > "$tmp_dir/bundled-models.json"

# Native OpenAI models need a ChatGPT plan. In auto mode, hide them from /model
# only when Codex's login shows a missing or lapsed plan.
if [[ "$native_models" == auto ]]; then
  native_models=show
  if [[ "$(node "$repo_dir/scripts/chatgpt-plan.mjs" "$codex_home")" == inactive ]]; then native_models=hide; fi
fi

node "$repo_dir/scripts/build-catalog.mjs" \
  --bundled "$tmp_dir/bundled-models.json" \
  --catalog-dir "$repo_dir/catalog" \
  --instructions "$repo_dir/prompts/openrouter-instructions.md" \
  --persistent "$repo_dir/prompts/openrouter-persistent.md" \
  --native-models "$native_models" \
  --output "$tmp_dir/models.json"

if [[ -n "$prompted_key" ]]; then
  printf '%s\n' "$prompted_key" | node "$repo_dir/scripts/prepare-credentials.mjs" "$router_env" --api-key-stdin
  prompted_key=""
elif [[ -n "$api_key_file" ]]; then
  node "$repo_dir/scripts/prepare-credentials.mjs" "$router_env" --api-key-file "$api_key_file"
else
  node "$repo_dir/scripts/prepare-credentials.mjs" "$router_env"
fi
merge_flags=()
if [[ "$force" -eq 1 ]]; then merge_flags+=(--force); fi
node "$repo_dir/scripts/merge-config.mjs" "$existing_config" "$codex_home" "$tmp_dir/config.toml" "$router_env" "$tmp_dir/unified-openrouter.config.toml" ${merge_flags[@]+"${merge_flags[@]}"}

jq -e '.models[] | select(.slug == "deepseek/deepseek-v4.1-flash-1017") | .context_window == 960000' \
  "$tmp_dir/models.json" >/dev/null

install -m 600 "$tmp_dir/config.toml" "$codex_home/config.toml"
install -m 600 "$tmp_dir/unified-openrouter.config.toml" "$codex_home/unified-openrouter.config.toml"
install -m 600 "$tmp_dir/models.json" "$codex_home/models.json"
install -m 600 "$repo_dir/router/unified-router.mjs" "$router_file"

if [[ -f "$codex_home/deepseek.config.toml" ]]; then
  mv "$codex_home/deepseek.config.toml" "$backup_dir/deepseek.config.toml.retired"
fi

wait_for_router() {
  local healthy=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25; do
    if node "$repo_dir/scripts/verify-health.mjs" "$router_file" http://127.0.0.1:18766/health 2>/dev/null; then
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

run_by_codex_daemon() {
  local pid=$$ command
  while [[ -n "$pid" && "$pid" -gt 1 ]]; do
    command="$(ps -o command= -p "$pid" 2>/dev/null)" || return 1
    [[ "$command" =~ ^([^[:space:]]*/)?codex[[:space:]]+app-server([[:space:]]|$) ]] && return 0
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  done
  return 1
}

# The shared app-server daemon keeps the configuration and catalog it started
# with. Restarting it interrupts its open sessions, so skip it when it is not
# running, when Codex itself runs this installer, or when asked not to.
if [[ "$service" -eq 1 && "$restart_daemon" -eq 1 ]] \
    && [[ "$(codex app-server daemon version 2>/dev/null | jq -r '.status // empty' 2>/dev/null)" == running ]]; then
  if run_by_codex_daemon; then
    printf 'Codex is running this installer, so its daemon was not restarted. Afterwards run: codex app-server daemon restart\n' >&2
  elif codex app-server daemon restart >/dev/null 2>&1; then
    printf 'Restarted the Codex app-server daemon.\n'
  else
    printf 'Could not restart the Codex app-server daemon. Run: codex app-server daemon restart\n' >&2
  fi
fi

printf 'Installed the Codex unified router in %s\n' "$codex_home"
printf 'Backups: %s\n' "$backup_dir"
printf '\nMain thread, DeepSeek: codex (default; or codex -m deepseek/deepseek-v4.1-flash-1017)\n'
if [[ "$native_models" == hide ]]; then
  printf 'Native OpenAI models:  hidden from /model (no active ChatGPT plan, or CODEX_ROUTER_NATIVE_MODELS=hide)\n'
else
  printf 'Main thread, OpenAI:   codex -m gpt-6-astra (requires a ChatGPT plan)\n'
fi
printf 'Main thread, Muse:     codex -m openrouter/meta/muse-spark-1.3-contributor (Meta trains on its prompts; share-safe code only)\n'
printf 'Ultra Spark mode:      codex -m ultra-spark/deepseek-v4.1-flash-1017 (DeepSeek delegating to Muse workers; fresh threads, share-safe code)\n'
printf '\nIn an existing session, child threads may use the same model names through spawn_agent model overrides.\n'
printf 'Restart Codex windows created before this install; they keep the provider they were started with.\n'
