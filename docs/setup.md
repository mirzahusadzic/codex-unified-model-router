# Setup and configuration

See the [README](../README.md) for installation commands.

## What the installer changes

The installer uses `~/.codex` by default and respects `CODEX_HOME`. It:

1. Backs up existing configuration and catalog files.
2. Merges Codex's bundled models with every JSON entry in [`catalog/`](../catalog/).
3. Updates managed settings in `config.toml`, preserving unrelated sections.
4. Installs the router and OpenRouter key under `unified-router/`.
5. Configures automatic startup and checks the local health endpoint.

The first conversion of an unmanaged configuration requires `--force` on macOS/Linux or `-Force` on Windows. Subsequent runs update the managed blocks without that flag.

Automatic startup uses launchd on macOS, `systemd --user` on Linux, and a hidden Startup-folder supervisor on Windows. If Linux has no working user service session, the installer prints a manual startup command.

## Activate the provider

Restart Codex windows that were open before installation and start a new thread. Existing threads retain the provider they were created with.

If Codex uses the shared app-server daemon, restart it once to load the new configuration:

```sh
codex app-server daemon restart
```

This interrupts active work in that daemon. Start a new thread afterward. Once a thread uses the unified provider, changing between OpenAI and OpenRouter models does not require another daemon restart.

## Managed configuration

```toml
model = "gpt-6-astra"
model_provider = "unified"
model_reasoning_effort = "xhigh"
model_catalog_json = "/absolute/path/to/.codex/models.json"

[model_providers.unified]
name = "Codex Unified Router"
base_url = "http://127.0.0.1:18766/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

The installer supplies the actual catalog path. Rerunning it reapplies these managed values.

## Routing and compatibility

| Requested model | Upstream service | Upstream model |
| --- | --- | --- |
| `gpt-6-astra` | Native Codex backend | `gpt-6-astra` |
| `deepseek/deepseek-v4.1-flash-1017` | OpenRouter | `deepseek/deepseek-v4.1-flash-1017` |
| `openrouter/vendor/model` | OpenRouter | `vendor/model` |

The same catalog is available to main threads, child-thread model overrides, and scheduling interfaces that expose a model field.

- **Reasoning effort:** OpenRouter requests map `medium` to `high`, and values such as `xhigh` and `ultra` to `max`. Native OpenAI requests retain the requested effort.
- **Mixed history:** OpenAI requests omit plaintext reasoning from OpenRouter history while preserving encrypted reasoning, chat messages, tool calls, and tool results.
- **Structured output:** OpenRouter requests with a non-text response format, including `json_schema`, route to `gpt-6-astra`. Set `CODEX_ROUTER_STRUCTURED_MODEL` in the router service environment to select another native OpenAI fallback.
- **Streaming:** Responses are piped through as they arrive. Client disconnects cancel unfinished upstream requests.

## Add a model

Native models come from Codex's bundled catalog; update Codex and rerun the installer to refresh them.

For an OpenRouter model:

1. Copy [`catalog/deepseek-model.json`](../catalog/deepseek-model.json) to another JSON file in `catalog/`.
2. Set `slug` to `openrouter/<exact-openrouter-model-slug>`.
3. Update the display name, description, context limits, reasoning levels, and other capabilities to match the model.
4. Rerun the installer.

The router removes the `openrouter/` prefix before forwarding. The model becomes available through the shared catalog.

The DeepSeek entry uses maintained instructions from [`prompts/`](../prompts/). After editing those files, refresh the checked-in entry:

```sh
./scripts/render-deepseek-entry.sh
```

The installer also injects these instructions into its generated catalog.

## Credentials and logging

The router binds only to `127.0.0.1`. OpenAI requests carry the incoming Codex authentication to `https://chatgpt.com/backend-api/codex/responses`. OpenRouter requests use the OpenRouter key and go to `https://openrouter.ai/api/v1/responses`.

The key is stored in `unified-router/openrouter.env` under your Codex home directory, outside this repository. The Unix installer restricts the file to mode `600`; the Windows installer applies a current-user ACL when writing it.

Logs contain routing metadata, status codes, and timings. Request and response bodies, authorization headers, and API keys are not logged.

## CI coverage

The [workflow](../.github/workflows/ci.yml) runs on pushes, pull requests, and manual dispatch. It tests Linux with Node.js 20, 22, and 24, plus macOS and Windows with Node.js 24. It also checks JavaScript, Bash, and Windows PowerShell syntax, and validates model definitions and prompt consistency.

Tests use synthetic upstream responses and need no API credentials. Live provider compatibility and installation of background services require separate manual verification.
