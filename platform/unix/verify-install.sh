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

if ! node -e 'const model = JSON.parse(require("fs").readFileSync(0, "utf8")).models
    .find(entry => entry.slug === "deepseek/deepseek-v4.1-flash-1017");
  process.exit(model?.context_window === 960000 && model.max_context_window === 960000 ? 0 : 1)' <"$codex_home/models.json"; then
  printf 'DeepSeek context limits are not 960000.\n' >&2
  exit 1
fi

node "$script_dir/verify-prompts.mjs" "$codex_home"

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
# Report what /model lists, from the installed catalog.
node -e 'const models = JSON.parse(require("fs").readFileSync(0, "utf8")).models;
  const routed = model => /^(deepseek|openrouter|ultra-spark)\//.test(model.slug);
  const native = models.filter(model => !routed(model) && model.visibility !== "hide").length;
  console.log(`Router models: ${models.filter(routed).map(model => model.slug).join(", ")}`);
  console.log(native ? `Native OpenAI models: ${native} in /model (require a ChatGPT plan)` : "Native OpenAI models: hidden from /model");' \
  <"$codex_home/models.json"
