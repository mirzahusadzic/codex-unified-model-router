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

Logs:

```text
~/Library/Logs/codex-unified-router.log
~/Library/Logs/codex-unified-router.error.log
```

Router output is newline-delimited JSON. Request-scoped events share a
`requestId`, while OpenRouter responses also record the upstream
`generationId`, `providerName`, `upstreamRequestId`, and `cloudflareRayId` when
those headers are present. Useful events include:

- `request.forwarded`: model route, request size, input item count, and any history repair.
- `history.repaired`: invalid, duplicate, unanswered, or orphaned tool records that were normalized.
- `upstream.response_started`: status and time to upstream headers.
- `upstream.response_finished`: final status and duration.
- `upstream.error`: transport failure code and duration.
- `request.finished` and `request.aborted`: local request outcome and total duration.

Logs never include request or response bodies, authorization headers, API
keys, cookies, or environment values. For example:

```sh
jq -c 'select(.event == "history.repaired" or .event == "upstream.error")' \
  ~/Library/Logs/codex-unified-router.log

jq -c 'select(.event == "upstream.response_started" and .status >= 400)' \
  ~/Library/Logs/codex-unified-router.error.log
```

### Linux

```sh
systemctl --user status codex-unified-router.service
systemctl --user restart codex-unified-router.service
journalctl --user -u codex-unified-router.service -f
```

To keep a user service running after logout, enable lingering if your system policy allows it:

```sh
loginctl enable-linger "$USER"
```

### Windows

The installer creates `Codex Unified Router.vbs` in the current user's Startup folder. It launches a hidden supervisor from `unified-router/start-router.cmd`. Rerun the installer to update and restart it.

Logs are under the installation directory, which defaults to:

```text
%USERPROFILE%\.codex\unified-router\router.log
%USERPROFILE%\.codex\unified-router\router.error.log
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
| OpenRouter returns HTTP 400 with `provider_name: null` | Check `request.forwarded` and `history.repaired` for the same `requestId`; update and restart the router so tool-history normalization is active. |
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
