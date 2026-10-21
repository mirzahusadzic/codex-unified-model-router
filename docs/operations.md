# Services and troubleshooting

The router and Codex's app-server daemon are separate processes. Restart the router after updating its installed code or service environment. Restart the Codex daemon when it needs to reload provider configuration.

## Verify an installation

```sh
./scripts/verify-install.sh
```

On Windows, run `.\scripts\verify-install.ps1`.

The verifiers check both the main and OpenRouter-only configurations, matching local tokens, private permissions, the catalog, local health, and platform startup setup. Readiness requires the supported routing policy and revision precondition, with the advertised revision matching the installed router source. Redirects and stale running copies fail verification. This does not validate upstream credentials or model access.

## Service management

### macOS

```sh
launchctl print "gui/$(id -u)/com.mirza.codex-unified-router"
launchctl kickstart -k "gui/$(id -u)/com.mirza.codex-unified-router"
```

Standard output (`info`) and standard error (`error`) logs:

```text
~/Library/Logs/codex-unified-router.log
~/Library/Logs/codex-unified-router.error.log
```

### Linux

```sh
systemctl --user status codex-unified-router.service
systemctl --user restart codex-unified-router.service
journalctl --user -u codex-unified-router.service -f
```

`journald` captures both standard output and standard error in the user journal. To keep the user service running after logout, enable lingering if your system policy allows it:

```sh
loginctl enable-linger "$USER"
```

### Windows

The installer creates `Codex Unified Router.vbs` in the current user's Startup folder. It launches a hidden supervisor from `unified-router/start-router.cmd`. Rerun the installer to update and restart it.

Standard output (`info`) and standard error (`error`) logs are under the installation directory, which defaults to:

```text
%USERPROFILE%\.codex\unified-router\router.log
%USERPROFILE%\.codex\unified-router\router.error.log
```

## Structured logs

The router emits newline-delimited JSON on every platform. Logging defaults to `error`; set `CODEX_ROUTER_LOG_LEVEL=info` in the router service environment to record successful requests and timings. `debug` is also accepted for future diagnostic detail. `error` records are written to standard error, while `info` and `debug` records use standard output. Request-scoped events share a `requestId`, and upstream responses include `generationId`, `providerName`, `upstreamRequestId`, and `cloudflareRayId` when those headers are present.

- `router.ready` and `router.shutdown`: listener address, OpenRouter key availability, running source `revision`, and shutdown signal.
- `request.forwarded`: model route, routing policy, `fallbackReason` when structured output falls back to OpenAI, whether unsupported OpenRouter response state was reset, payload byte length, input item count, and any tool-history repair summary.
- `history.repaired`: invalid, duplicate, unanswered, or orphaned tool records normalized before an OpenRouter request.
- `upstream.response_started`: upstream HTTP status, time to headers, and trace identifiers (`error` level when `status >= 400`).
- `upstream.response_finished`: final upstream HTTP status, total upstream duration, and trace identifiers (`error` level when `status >= 400`).
- `upstream.error`: upstream transport or stream failure code (`errorCode`) and duration.
- `request.finished` and `request.aborted`: local HTTP status (`error` level when `status >= 400`) or client disconnect before completion, with total request duration.

Logs never include request or response bodies, authorization headers, API keys, local router tokens, cookies, or environment values.

Codex's session JSONL remains the source of truth for cache and token accounting. Each `token_usage_record` contains `cached_input_tokens`, `input_tokens`, and `cache_write_input_tokens`; the same file identifies the active model. Router records now include the same opaque `sessionId` when Codex supplies its `session_id` header, so retain the session file and the router logs together when investigating cache behavior. Do not append router logs to the session file.

For example, calculate a session's overall cache-read share:

```sh
jq -s '
  [.[] | select(.type == "token_usage_record") | .payload.usage] as $usage
  | ($usage | map(.input_tokens) | add // 0) as $input
  | ($usage | map(.cached_input_tokens) | add // 0) as $cached
  | {input_tokens: $input, cached_input_tokens: $cached,
     cache_read_share: (if $input > 0 then $cached / $input else null end)}
' ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
```

Correlate router events with that session by filtering for its `sessionId`. The session file's `session_id` and router log's `sessionId` use the same value.

Because `info` and `error` events use standard output and standard error respectively, macOS and Windows write them to separate `.log` and `.error.log` files, while Linux records both in `journald`. Pass both files when correlating a `requestId` across levels on file-based setups. The `info` examples below require `CODEX_ROUTER_LOG_LEVEL=info`:

```sh
# Inspect tool-history repairs (stdout) or error events (stderr) on macOS
jq -c 'select(.event == "history.repaired")' ~/Library/Logs/codex-unified-router.log
jq -c 'select(.level == "error")' ~/Library/Logs/codex-unified-router.error.log

# Correlate all events for one requestId across stdout and stderr log files
jq -c --arg id "<request-id>" 'select(.requestId == $id)' \
  ~/Library/Logs/codex-unified-router.log \
  ~/Library/Logs/codex-unified-router.error.log

# Filter the combined stream from the Linux user journal
journalctl --user -u codex-unified-router.service -o cat \
  | jq -c 'select(.event == "history.repaired" or .level == "error")'
```

On Windows PowerShell, inspect `router.log` and `router.error.log` under `$HOME\.codex\unified-router` (or `$env:CODEX_HOME\unified-router`):

```powershell
Get-Content "$HOME\.codex\unified-router\router.log", "$HOME\.codex\unified-router\router.error.log" |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.event -eq 'history.repaired' -or $_.level -eq 'error' }
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| A new model is missing from `/model` | Rerun the installer to rebuild the catalog, then restart Codex. |
| A thread still uses the previous provider | [Activate the unified provider](setup.md#activate-the-provider) and start a new thread. |
| The local endpoint is unavailable | Check the service status and router error log. |
| OpenRouter returns HTTP 401 | Rerun the installer with a valid `OPENROUTER_API_KEY` to replace the configured key. |
| Structured output fails on DeepSeek | Verify the thread uses the unified provider and the fallback model is a native OpenAI model. |
| Switching to OpenAI produces a reasoning-content error | Update and restart the installed router so history normalization is active. |
| OpenRouter returns HTTP 400 with `provider_name: null` | Check `request.forwarded` for `stateReset` and `historyRepairs`, plus `upstream.response_started`, for the same `requestId`. OpenRouter Responses is stateless; update and restart the router so unsupported continuation fields and tool history are normalized. |
| Replies are slow | Inspect upstream header timings and request durations. Headers can arrive before model output; these timings do not measure first-token latency. |

Restarting either service interrupts its active requests. Changing models inside a thread already using the unified provider does not require a service restart.

## Install without automatic startup

After upgrading to router token authentication, rerun the installer and restart Codex, including its shared daemon if used. Start a new thread so Codex loads the generated provider header. A `401` about a missing router token usually means the client still has the previous configuration.

Use `./install.sh --no-service` on macOS/Linux or `.\install.ps1 -NoService` on Windows. These options write the configuration and router files but do not register or launch a background service.

Use `./scripts/verify-install.sh --no-service` or `.\scripts\verify-install.ps1 -NoService` to validate those files. The installer still requires Codex and an OpenRouter key.

## Rollback

The installer prints the backup directory for each run. Stop automatic startup, then restore the configuration and catalog from your chosen backup.

### Stop automatic startup

On macOS:

```sh
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.mirza.codex-unified-router.plist
mv ~/Library/LaunchAgents/com.mirza.codex-unified-router.plist ~/.Trash/
```

On Linux:

```sh
systemctl --user disable --now codex-unified-router.service
rm ~/.config/systemd/user/codex-unified-router.service
systemctl --user daemon-reload
```

On Windows, remove the Startup entry, then sign out and back in to stop the supervisor and router:

```powershell
$startupEntry = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Unified Router.vbs'
Remove-Item -LiteralPath $startupEntry
```

### Restore configuration

For the default macOS/Linux installation, substitute the backup path printed by the installer:

```sh
backup_dir="$HOME/.codex/backups/codex-unified-router-YYYYMMDD-HHMMSS-PID"
cp -p "$backup_dir/config.toml" "$HOME/.codex/config.toml"
cp -p "$backup_dir/models.json" "$HOME/.codex/models.json"
```

On Windows, copy `config.toml` and `models.json` from the backup into your Codex home directory. If you installed with a custom `CODEX_HOME`, restore files there.

Restore `unified-openrouter.config.toml` as well if it is present in the chosen backup and you use that profile.

Only restore files present in the backup. A missing file did not exist before that installation; remove its generated counterpart if returning to that earlier state. Restart Codex, including its shared daemon if used, and start new threads to use the restored provider configuration.
