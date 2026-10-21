# Setup and configuration

See the [README](../README.md) for installation commands.

## What the installer changes

The installer uses `~/.codex` by default and respects `CODEX_HOME`. It:

1. Backs up existing configuration and catalog files.
2. Merges Codex's bundled models with every JSON entry in [`catalog/`](../catalog/).
3. Updates managed settings in `config.toml`, preserving unrelated sections, [turns off Codex's ChatGPT apps](#chatgpt-apps) unless `CODEX_ROUTER_DISABLE_APPS=0`, and [allows 10 spawned agents](#spawned-agent-limit) unless `CODEX_ROUTER_AGENT_THREADS` says otherwise.
4. Merges managed transport settings into `unified-openrouter.config.toml` for OpenRouter without ChatGPT authentication, preserving unrelated preferences.
5. Installs the router and OpenRouter key under `unified-router/`.
6. Configures automatic startup and checks the local health endpoint.

The first conversion of either an unmanaged main configuration or an existing unmanaged `unified-openrouter.config.toml` requires `--force` on macOS/Linux or `-Force` on Windows. Without it, the installer stops before modifying files or credentials. Both configurations are backed up before merging. Subsequent runs update the managed blocks without that flag. The sidecar's managed settings own only `model_provider`, `model_catalog_json` and `[model_providers.unified]`; keep custom model, reasoning, instructions and unrelated tables outside its managed blocks.

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
model = "deepseek/deepseek-v4.1-flash-1017"
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

[features]
apps = false

[agents]
max_concurrent_threads_per_session = 10
```

The installer supplies the actual catalog path and a random local router token. Rerunning it reapplies these managed values and retains the token.

### ChatGPT apps

Codex's ChatGPT apps feature adds connector tools, such as GitHub, Sites and ChatGPT spaces, to every request, whatever the model. With Codex 0.163.0 and an account with apps connected, they made up about 237,000 characters (roughly 65,000 tokens) of a 270 KB request; without them the request was 32 KB. OpenRouter bills those tokens on every uncached request, and they slow cold starts.

The installer therefore manages `apps = false`. It edits an existing `[features]` table in place, keeping its other keys, or adds one; the managed line sits between `# BEGIN/END codex-unified-router features` markers. The OpenRouter-only profile inherits the setting. To keep the apps, install with `CODEX_ROUTER_DISABLE_APPS=0` (PowerShell: `$env:CODEX_ROUTER_DISABLE_APPS = '0'`) and run the verifier with the same value; the installer then removes its managed line and leaves `apps` to you. Top-level `features.*` keys must move into a `[features]` table first. For a single session, `codex --enable apps` or `codex --disable apps` overrides the configuration.

### Spawned-agent limit

The installer manages `max_concurrent_threads_per_session = 10` in the `[agents]` table, the number of spawned agents a session can keep open, excluding the main thread. [Ultra Spark](#ultra-spark-mode) uses it to run up to 10 workers in parallel. Like the apps setting, it edits an existing `[agents]` table in place, keeping custom roles and other keys, and replaces Codex's legacy `max_threads` alias. Install with `CODEX_ROUTER_AGENT_THREADS=<1-999>` for another limit, or `CODEX_ROUTER_AGENT_THREADS=0` to leave the limit to Codex, and run the verifier with the same value.

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

## Muse Spark 1.3 Contributor

[`catalog/muse-model.json`](../catalog/muse-model.json) adds `openrouter/meta/muse-spark-1.3-contributor` with OpenRouter's published **1,048,576-token** context and a 95% effective budget. Reasoning is mandatory upstream, so the entry offers `low` through `max` (default `medium`) and no `none`; it also declares no parallel tool calls.

This is Meta's contributor tier: the price is lower because Meta uses prompts and completions to improve its products, and Codex sends file contents and command output with each step. Use it only for code you are willing to share, such as public repositories. OpenRouter routes to it only after you allow endpoints that may train on inputs in your OpenRouter privacy settings.

## Ultra Spark mode

**DeepSeek V4.1 Flash 1017 · Ultra Spark** (`openrouter/deepseek/deepseek-v4.1-flash-1017`) is the same upstream DeepSeek model with one addition: [`prompts/ultra-spark.md`](../prompts/ultra-spark.md) makes delegation the default: it splits broad tasks such as reviews across parallel Muse Spark 1.3 Contributor workers and hands them chores such as code searches, test runs, and mechanical edits through Codex's `spawn_agent` tool, running up to 10 at once. Its default reasoning effort is `max`. Design decisions, final edits, and verification stay in the DeepSeek thread, and workers are spawned with `fork_context: false`, so they see only their task.

Switch it on or off in a thread with `/model`. Workers inherit the [Muse contributor terms](#muse-spark-13-contributor): Meta trains on everything they receive. Use the mode only for code you are willing to share, and start it in a fresh thread. A thread that already holds other models' output, such as native OpenAI turns, should not be handed to it.

## Routing and compatibility

| Requested model | Upstream service | Upstream model |
| --- | --- | --- |
| `gpt-6-astra` | Native Codex backend | `gpt-6-astra` |
| `deepseek/deepseek-v4.1-flash-1017` | OpenRouter | `deepseek/deepseek-v4.1-flash-1017` |
| `openrouter/meta/muse-spark-1.3-contributor` | OpenRouter | `meta/muse-spark-1.3-contributor` |
| `openrouter/deepseek/deepseek-v4.1-flash-1017` (Ultra Spark) | OpenRouter | `deepseek/deepseek-v4.1-flash-1017` |
| `openrouter/vendor/model` | OpenRouter | `vendor/model` |

The same catalog is available to main threads, child-thread model overrides, and scheduling interfaces that expose a model field.

- **Reasoning effort:** DeepSeek requests map `medium` to `high`, and values such as `xhigh` and `ultra` to `max`, because DeepSeek accepts only `low`, `high`, `max`, and `none`. Other OpenRouter requests keep the requested effort, which OpenRouter translates for each provider. Native OpenAI requests retain the requested effort.
- **Mixed history:** OpenAI requests omit plaintext reasoning from OpenRouter history while preserving encrypted reasoning, chat messages, tool calls, and tool results.
- **Stateless continuation:** OpenRouter's Responses API does not support stored response state, so the router removes `previous_response_id` and disables `store: true`. Codex continues to send the full conversation history in `input`.
- **Rejected-step recovery:** A pre-stream OpenRouter HTTP 400 that reports a context-window overflow becomes a streamed `context_length_exceeded` failure, so Codex compacts the thread. Other pre-stream 400s get one bounded retry without encrypted reasoning and, for large histories, with a bounded recent tail of the latest turn. If that also fails, the router returns a completed Codex diagnostic response instead of forwarding HTTP 400, preserving the thread. Exact rejected bodies are never logged; an explicit `CODEX_ROUTER_REJECTED_REQUEST_DIR` setting can capture them privately for diagnosis.
- **Structured output:** Requests keep the selected model. DeepSeek receives JSON mode plus the schema as an instruction; other OpenRouter models receive the schema as sent. See [Routing policy](#routing-policy).
- **Streaming:** Responses are piped through as they arrive. Client disconnects cancel unfinished upstream requests.
- **Endpoint preferences:** `CODEX_ROUTER_PROVIDER_ORDER` can [prefer specific OpenRouter endpoints](#openrouter-endpoint-preferences) per model.

### OpenRouter endpoint preferences

OpenRouter chooses an endpoint for each request. To prefer particular endpoints for a model, add `CODEX_ROUTER_PROVIDER_ORDER` to `unified-router/openrouter.env`, which the installer keeps, and restart the router:

```sh
CODEX_ROUTER_PROVIDER_ORDER=deepseek/deepseek-v4.1-flash-1017=deepseek
```

The key is the upstream model slug, without the `openrouter/` prefix. List several endpoints with commas, and separate models with `;`. Endpoint tags come from `https://openrouter.ai/api/v1/models/<model>/endpoints`. The router adds `provider: { order: [...] }` only when the request has no `provider` field. Fallbacks stay enabled, so an outage of the preferred endpoint costs a cache miss instead of failing the turn, and OpenRouter's own sticky routing does not apply while an order is set. A malformed value stops the router at startup; `request.forwarded` logs the applied `providerOrder`.

## Routing policy

The router always forwards the model you selected and never substitutes another, including for structured output. DeepSeek's endpoint rejects JSON schemas, so for DeepSeek a `json_schema` response format becomes JSON mode with the schema appended as the final developer instruction: replies follow the schema, but the provider does not enforce it, and the unchanged history keeps its cache hits. `request.forwarded` logs `structuredOutputAdapted`. Other OpenRouter models receive the schema unchanged.

The `X-Codex-Routing-Policy: preserve-model-v1` header, which the OpenRouter-only profile sends, is still accepted and now matches the default behavior. Unknown policy values receive HTTP 400. The policy header and local authentication token are never forwarded to providers.

## Router capabilities

`GET /health` (also `/v1/health`) exposes `capabilities.routingPolicies`, the
supported opt-in routing policies, `capabilities.openrouterRejectionRecovery`,
the bounded OpenRouter 400 fallback contract, and `revision`, the running router
source's SHA-256. These fields let clients check compatibility and diagnose
outdated installed copies without sending an inference request.
They do not attest upstream model identity, account access or the entire
runtime configuration.

Clients that need to hold that revision across requests can require it with:

```http
X-Codex-Router-Revision: <lowercase-sha256-from-health>
```

Support is advertised as `capabilities.revisionPrecondition: true`. After local
authentication, the router rejects malformed digests with HTTP 400 and mismatches
with HTTP 409 (`router_revision_mismatch`), before contacting either upstream.
Matching or absent headers leave routing unchanged. The header stays local and
is never forwarded. Check the capability before relying on it: older routers
may ignore unknown headers. This optional precondition detects a changed source
revision, not a restart of identical code or changes to service configuration.

## OpenRouter-only profile

The installer writes `unified-openrouter.config.toml` beside `config.toml`, with
the same private local router token and model catalog. It sets
`requires_openai_auth = false`, so OpenRouter requests need no ChatGPT login,
and enables `preserve-model-v1` to prevent fallback into a native OpenAI route.
The default mixed-provider configuration is unchanged.

Select this profile with an OpenRouter model:

```sh
codex --profile unified-openrouter --model deepseek/deepseek-v4.1-flash-1017
```

Use the normal mixed-provider configuration for native OpenAI models or for
switching between OpenAI and OpenRouter in one thread. The OpenRouter-only
profile supplies transport settings, not prompts, plugins or task policies.
It still inherits base user and project settings; it is not a sandbox or an
isolated execution mode. Codex 0.163.0 does not load the sidecar profile with
`--ignore-user-config`.

Clients that need isolated execution must manage their own Codex home,
instructions, tools, permissions and output validation. The router remains a
transport and compatibility layer.

After updating sources, rerun the installer to install the profile and router;
the repository copy alone does not change the running service. Installation and
service activation should be scheduled around active requests.

## Add a model

Native models come from Codex's bundled catalog; update Codex and rerun the installer to refresh them.

For an OpenRouter model:

1. Copy [`catalog/deepseek-model.json`](../catalog/deepseek-model.json) to another JSON file in `catalog/`.
2. Set `slug` to `openrouter/<exact-openrouter-model-slug>`.
3. Update the display name, description, context limits, reasoning levels, and other capabilities to match the model.
4. Rerun the installer. The catalog build fails on a duplicate slug, a slug that matches a bundled Codex model, or a missing prompt file.

The router removes the `openrouter/` prefix before forwarding. The model becomes available through the shared catalog.

Every `deepseek/` and `openrouter/` entry uses the maintained instructions from [`prompts/`](../prompts/). An entry can append one more prompt from that directory by naming it in `router_instructions_suffix`, as Ultra Spark does; the generated Codex catalog omits that field. After editing those files or adding an entry, refresh the checked-in entries:

```sh
node scripts/render-openrouter-entries.mjs
```

The installer also injects these instructions into its generated catalog.

## Credentials and logging

The router binds only to `127.0.0.1`. OpenAI requests carry the incoming Codex authentication to `https://chatgpt.com/backend-api/codex/responses`. OpenRouter requests use the OpenRouter key and go to `https://openrouter.ai/api/v1/responses`.

The OpenRouter key and a random local router token are stored in `unified-router/openrouter.env` under your Codex home directory, outside this repository. Codex sends the local token through its provider `http_headers` setting in `config.toml`; the router removes it before forwarding. Model requests and model listings require that token. The health endpoint remains available without authentication.

Credential-bearing files, including the OpenRouter-only profile, are private: the Unix installer uses mode `600` and a private router directory; the Windows installer replaces inherited and explicit access rules with a current-user-only ACL before writing or reusing credentials. Configuration backups and temporary installation directories are also private. These permissions do not isolate software running as your own user or an administrator.

The router rejects browser origins, unexpected Host headers, and non-JSON model requests. Provider-specific header allowlists prevent unrelated credentials from being forwarded. Request bodies are limited to 64 MiB each; this is a local single-user service, not a shared network gateway.

To upgrade an existing installation to token authentication, rerun the installer, restart Codex (including the shared daemon if used), and start a new thread. Existing sessions do not acquire the new provider header automatically. The verifier checks both configurations against the stored token, their managed transport settings, and private ownership/permissions. Readiness checks require the current capabilities and the installed source's SHA-256; a reachable older router is not a successful upgrade. Health redirects are rejected.

Logging defaults to errors only. Set `CODEX_ROUTER_LOG_LEVEL=info` in `unified-router/openrouter.env` or the service environment to record successful request metadata, status codes, and timings. Request and response bodies, authorization headers, and API keys are not logged. Set `CODEX_ROUTER_REJECTED_REQUEST_DIR` only when an exact OpenRouter-rejected payload is needed for diagnosis; captured files are private but contain complete conversation content. See [Structured logs](operations.md#structured-logs) for event names and platform log locations.

## CI coverage

The [workflow](../.github/workflows/ci.yml) runs on pushes, pull requests, and manual dispatch. It tests Linux with Node.js 20, 22, and 24, plus macOS and Windows with Node.js 24. It also checks JavaScript, Bash, and Windows PowerShell syntax, and validates the model JSON. `node --test` checks that catalog entries carry the rendered prompts.

Tests use synthetic upstream responses and need no API credentials. Live provider compatibility and installation of background services require separate manual verification.

## License and template provenance

This project is licensed under [Apache-2.0](../LICENSE). [NOTICE](../NOTICE) preserves the applicable OpenAI attribution. This is an independent community project.

The DeepSeek catalog entry includes model-message templates that match the bundled catalog of `@openai/codex` **0.163.0**, whose package metadata declares Apache-2.0. The [adjacent file notice](../catalog/deepseek-model.json.license) identifies those sections and the modifications. The Muse and Ultra Spark entries derive from the same template, as recorded in their notices ([Muse](../catalog/muse-model.json.license), [Ultra Spark](../catalog/deepseek-ultra-spark-model.json.license)). Keep the licenses and applicable notices when redistributing an entry or a modified copy; record your own changes as well.

The main and persistent instructions are maintained separately in [`prompts/`](../prompts/). They are not verbatim copies of the corresponding instructions in that installed Codex catalog; this comparison does not establish originality against other sources. Native model entries are read from the user's installed Codex during installation.

The software license does not grant access to models or hosted services. OpenAI and OpenRouter access remains subject to their respective service terms.
