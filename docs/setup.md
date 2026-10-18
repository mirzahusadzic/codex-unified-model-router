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
http_headers = { "X-Codex-Router-Token" = "<generated-by-installer>" }
```

The installer supplies the actual catalog path and a random local router token. Rerunning it reapplies these managed values and retains the token.

## DeepSeek context window

The entry for `deepseek/deepseek-v4.1-flash-1017` in [`catalog/deepseek-model.json`](../catalog/deepseek-model.json) preconfigures:

| Catalog setting | Value | Meaning |
| --- | --- | --- |
| `context_window` | `960000` | Configured context window in tokens. |
| `max_context_window` | `960000` | Maximum context window declared by this entry. |
| `effective_context_window_percent` | `95` | Effective budget of **912,000 tokens** (`960,000 × 95%`). |
| `auto_compact_token_limit` | `null` | No explicit compaction threshold supplied by the catalog. |

Both installers merge this entry into `models.json` under your Codex home directory and configure `model_catalog_json` to load it. No manual context-window setting is needed. These values belong to the DeepSeek entry; native OpenAI models retain their bundled catalog limits.

The effective budget covers the conversation context, including instructions, messages, and tool results; it is not a maximum output length. These are the project's configured limits, not a live measurement of upstream capacity. Start a fresh DeepSeek thread after installing or updating the catalog to check the effective window.

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

The OpenRouter key and a random local router token are stored in `unified-router/openrouter.env` under your Codex home directory, outside this repository. Codex sends the local token through its provider `http_headers` setting in `config.toml`; the router removes it before forwarding. Model requests and model listings require that token. The health endpoint remains available without authentication.

Both credential files are private: the Unix installer uses mode `600` and a private router directory; the Windows installer replaces inherited and explicit access rules with a current-user-only ACL before writing or reusing credentials. Configuration backups and temporary installation directories are also private. These permissions do not isolate software running as your own user or an administrator.

The router rejects browser origins, unexpected Host headers, and non-JSON model requests. Provider-specific header allowlists prevent unrelated credentials from being forwarded. Request bodies are limited to 64 MiB each; this is a local single-user service, not a shared network gateway.

To upgrade an existing installation to token authentication, rerun the installer, restart Codex (including the shared daemon if used), and start a new thread. Existing sessions do not acquire the new provider header automatically. The verifier checks that the stored and configured tokens match.

Logs contain routing metadata, status codes, and timings. Request and response bodies, authorization headers, and API keys are not logged.

## CI coverage

The [workflow](../.github/workflows/ci.yml) runs on pushes, pull requests, and manual dispatch. It tests Linux with Node.js 20, 22, and 24, plus macOS and Windows with Node.js 24. It also checks JavaScript, Bash, and Windows PowerShell syntax, and validates model definitions and prompt consistency.

Tests use synthetic upstream responses and need no API credentials. Live provider compatibility and installation of background services require separate manual verification.

## License and template provenance

This project is licensed under [Apache-2.0](../LICENSE). [NOTICE](../NOTICE) preserves the applicable OpenAI attribution. This is an independent community project.

The DeepSeek catalog entry includes model-message templates that match the bundled catalog of `@openai/codex` **0.163.0**, whose package metadata declares Apache-2.0. The [adjacent file notice](../catalog/deepseek-model.json.license) identifies those sections and the modifications. Keep the license and applicable notices when redistributing this entry or a modified copy; record your own changes as well.

The main and persistent instructions are maintained separately in [`prompts/`](../prompts/). They are not verbatim copies of the corresponding instructions in that installed Codex catalog; this comparison does not establish originality against other sources. Native model entries are read from the user's installed Codex during installation.

The software license does not grant access to models or hosted services. OpenAI and OpenRouter access remains subject to their respective service terms.
