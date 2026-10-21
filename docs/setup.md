# Setup and configuration

See the [README](../README.md) for installation commands. This page covers what the installer changes, every setting it reads, the models in the catalog, and how the router routes requests.

- [Installation](#installation): what changes, [installer settings](#installer-settings), and [activating the provider](#activate-the-provider)
- [Router settings](#router-settings): runtime options in `unified-router/openrouter.env`
- [Managed Codex configuration](#managed-codex-configuration): the Codex settings the installer owns
- [Models](#models): DeepSeek, Ultra Spark, Muse, and [adding a model](#add-a-model)
- [Routing](#routing): compatibility, [provider isolation](#provider-isolation), structured output, and profiles
- [Credentials and logging](#credentials-and-logging), [CI coverage](#ci-coverage), and [license](#license-and-template-provenance)

## Installation

### What the installer changes

The installer configures `~/.codex`, or `CODEX_HOME` when set. Each run:

1. Backs up the existing configuration and catalog files.
2. Builds `models.json` from Codex's bundled models and every entry in [`catalog/`](../catalog/), hiding native OpenAI models [without an active ChatGPT plan](#native-openai-models).
3. Merges its [managed settings](#managed-codex-configuration) into `config.toml`, preserving everything else.
4. Merges transport settings into `unified-openrouter.config.toml`, the [OpenRouter-only profile](#openrouter-only-profile).
5. Installs the router and stores the OpenRouter key under `unified-router/`.
6. Starts the router as a service, checks its health, and restarts a running Codex app-server daemon.

The helper scripts behind these steps are listed in [CONTRIBUTING.md](../CONTRIBUTING.md#scripts).

### Installer settings

Pass settings as flags or environment variables on each run; the installer does not store them:

```sh
./platform/unix/install.sh --force
CODEX_ROUTER_NATIVE_MODELS=hide CODEX_ROUTER_AGENT_THREADS=6 ./platform/unix/install.sh
```

```powershell
$env:CODEX_ROUTER_NATIVE_MODELS = 'hide'
.\platform\windows\install.ps1 -Force
```

Run the verifier with the same `CODEX_ROUTER_DISABLE_APPS`, `CODEX_ROUTER_DISABLE_ANALYTICS`, and `CODEX_ROUTER_AGENT_THREADS` values.

| Setting | Values | Effect |
| --- | --- | --- |
| `--force` (Windows: `-Force`) | flag | Allows the first conversion of an existing, unmanaged `config.toml` or `unified-openrouter.config.toml`. |
| `--no-service` (Windows: `-NoService`) | flag | Writes configuration and router files without starting a service or restarting the Codex daemon. |
| `--api-key-file <path>` (Windows: `-ApiKeyFile <path>`) | file path | Reads the OpenRouter key from the file's first line and replaces any stored key. Without it, the first install asks for the key without echoing it, and later installs reuse the stored key. |
| `OPENROUTER_API_KEY` | API key | Also supplies or replaces the key, for automation that cannot use a file. Prefer the prompt or `--api-key-file`: environment variables can leak to other processes and logs. |
| `CODEX_HOME` | path; default `~/.codex` | Codex home directory to configure. |
| `CODEX_ROUTER_NATIVE_MODELS` | `auto` (default), `show`, `hide` | Whether native OpenAI models appear in `/model`. See [Native OpenAI models](#native-openai-models). |
| `CODEX_ROUTER_DISABLE_APPS` | `1` (default), `0` | `1` turns off Codex's ChatGPT connector tools; `0` leaves them to you. See [ChatGPT apps](#chatgpt-apps). |
| `CODEX_ROUTER_DISABLE_ANALYTICS` | `1` (default), `0` | `1` turns off Codex analytics; `0` leaves them to you. See [Codex analytics](#codex-analytics). |
| `CODEX_ROUTER_AGENT_THREADS` | `10` (default), `1`–`999`, `0` | Spawned-agent limit per session; `0` leaves it to Codex. See [Spawned-agent limit](#spawned-agent-limit). |
| `CODEX_ROUTER_RESTART_DAEMON` | `1` (default), `0` | `0` skips restarting a running Codex app-server daemon. See [Activate the provider](#activate-the-provider). |

### Existing configuration

Converting an existing, unmanaged `config.toml` or `unified-openrouter.config.toml` requires `--force` the first time; without it, the installer stops before changing any file or credential. Both files are backed up before merging, and later runs update the managed blocks without the flag. In the profile, the managed blocks own only `model_provider`, `model_catalog_json`, and `[model_providers.unified]`; keep custom models, reasoning settings, instructions, and other tables outside them.

### Automatic startup

The router runs under launchd on macOS, `systemd --user` on Linux, and a hidden Startup-folder supervisor on Windows. If Linux has no working user service session, the installer prints a manual startup command. See [Services and troubleshooting](operations.md) to manage the service.

### Activate the provider

Restart Codex windows that were open before installation and start a new thread; existing threads keep the provider they were created with.

The shared Codex app-server daemon keeps the configuration and catalog it started with, so the installer restarts it when it is running, which interrupts work in its open sessions. The installer skips the restart with `--no-service`, with `CODEX_ROUTER_RESTART_DAEMON=0`, and when Codex itself runs the installer, which the restart would interrupt. In those cases, restart it yourself once:

```sh
codex app-server daemon restart
```

Start a new thread afterward. Once a thread uses the unified provider, switching models does not require another restart.

## Router settings

The router reads these settings when it starts, from `unified-router/openrouter.env` under your Codex home directory or from its service environment. Prefer the file: the installer keeps extra settings there when you rerun it, while it regenerates the service environment. For example:

```sh
# ~/.codex/unified-router/openrouter.env
# The installer writes the first two lines; add your settings below them.
OPENROUTER_API_KEY=...
CODEX_ROUTER_TOKEN=...
CODEX_ROUTER_LOG_LEVEL=info
CODEX_ROUTER_PROVIDER_ORDER=deepseek/deepseek-v4.1-flash-1017=deepseek
```

Put comments on their own lines; a `#` after a value becomes part of the value.

Restart the router after a change, for example by rerunning the installer.

| Variable | Default | Effect |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | set by the installer | OpenRouter key. To replace it, rerun the installer with `--api-key-file`. |
| `CODEX_ROUTER_TOKEN` | generated by the installer | Local token that Codex sends with each request. Do not edit; the installer keeps it in sync with the Codex configuration. |
| `CODEX_ROUTER_LOG_LEVEL` | `error` | `error`, `info`, or `debug`. See [Structured logs](operations.md#structured-logs). |
| `CODEX_ROUTER_REJECTED_REQUEST_DIR` | unset | Directory for private copies of OpenRouter-rejected request and response bodies. On Windows, only `unified-router` itself is accepted. See [Structured logs](operations.md#structured-logs). |
| `CODEX_ROUTER_PROVIDER_ORDER` | unset | Preferred OpenRouter endpoints per model. See [OpenRouter endpoint preferences](#openrouter-endpoint-preferences). |
| `CODEX_ROUTER_TRAINING_MODELS` | unset | Comma-separated upstream slugs to add to the training tier. See [Provider isolation](#provider-isolation). |

The service environment also sets `CODEX_ROUTER_ENV_FILE`, `CODEX_MODEL_CATALOG`, and `CODEX_ROUTER_PORT` (`18766`). The managed Codex configuration expects port `18766`, so leave these to the installer.

## Managed Codex configuration

The installer manages these settings in `config.toml`, between `# BEGIN/END codex-unified-router` markers, and supplies the real catalog path and a random local token. Rerunning it reapplies them and keeps the token.

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

[analytics]
enabled = false

[agents]
max_concurrent_threads_per_session = 10
```

The installer edits existing `[features]`, `[analytics]`, and `[agents]` tables in place and keeps their other keys. Move any top-level dotted keys, such as `features.apps`, into the table first. The OpenRouter-only profile inherits these settings.

### ChatGPT apps

Codex's ChatGPT apps feature adds connector tools, such as GitHub, Sites, and ChatGPT spaces, to every request, whatever the model. With Codex 0.163.0 and an account with apps connected, they made up about 237,000 characters (roughly 65,000 tokens) of a 270 KB request; without them, the request was 32 KB. OpenRouter bills those tokens on every uncached request, and they slow cold starts.

The installer therefore manages `apps = false`. To keep the apps, install with `CODEX_ROUTER_DISABLE_APPS=0`. For a single session, `codex --enable apps` or `codex --disable apps` overrides the configuration.

### Codex analytics

Codex sends usage analytics and metrics to OpenAI by default. The installer manages `enabled = false` in `[analytics]`, which also turns off Codex's default metrics exporter, so model choices and usage stay on your machine. Install with `CODEX_ROUTER_DISABLE_ANALYTICS=0` to leave analytics to Codex. `/feedback` still sends a report only when you submit one.

### Native OpenAI models

Codex's bundled models are native OpenAI models and require a ChatGPT plan. With `CODEX_ROUTER_NATIVE_MODELS=auto`, the installer reads the plan claims in Codex's login (`auth.json`) locally and hides these models from `/model` when the login is missing or the plan has lapsed. The claims are a snapshot from Codex's last token refresh, so an unclear result keeps the models listed; `show` and `hide` override the check. Hidden models stay usable by name, for example `codex -m gpt-6-astra`. Rerun the installer after your plan changes.

Approval prompts do not depend on a plan: `approvals_reviewer` defaults to `user`, so you answer them yourself. Setting it to `auto_review` hands prompts to Codex's reviewer model, `codex-auto-review`, which is a native OpenAI model and fails without a plan. Full access is not needed to work without a plan.

### Spawned-agent limit

`max_concurrent_threads_per_session` limits how many spawned agents a session can keep open, excluding the main thread. The installer sets it to 10 so [Ultra Spark](#ultra-spark-mode) can run 10 workers in parallel, and replaces Codex's legacy `max_threads` alias. Install with `CODEX_ROUTER_AGENT_THREADS=<1-999>` for another limit, or `0` to leave it to Codex.

## Models

| Model | Slug | Context | Notes |
| --- | --- | --- | --- |
| **DeepSeek V4.1 Flash 1017** (default) | `deepseek/deepseek-v4.1-flash-1017` | 960,000 tokens | [Context window](#deepseek-context-window) |
| **DeepSeek V4.1 Flash 1017 · Ultra Spark** | `ultra-spark/deepseek-v4.1-flash-1017` | 960,000 tokens | Delegates to Muse workers; see [Ultra Spark mode](#ultra-spark-mode) |
| **Muse Spark 1.3 Contributor** | `openrouter/meta/muse-spark-1.3-contributor` | 1,048,576 tokens | Meta trains on its inputs; see [Muse Spark 1.3 Contributor](#muse-spark-13-contributor) |
| Native OpenAI models | for example `gpt-6-astra` | bundled limits | Require a ChatGPT plan; see [Native OpenAI models](#native-openai-models) |

### DeepSeek context window

The entry for `deepseek/deepseek-v4.1-flash-1017` in [`catalog/deepseek-model.json`](../catalog/deepseek-model.json) preconfigures:

| Catalog setting | Value | Meaning |
| --- | --- | --- |
| `context_window` | `960000` | Configured context window in tokens. |
| `max_context_window` | `960000` | Maximum context window declared by this entry. |
| `effective_context_window_percent` | `95` | Effective budget of **912,000 tokens** (`960,000 × 95%`). |
| `auto_compact_token_limit` | `null` | No explicit compaction threshold supplied by the catalog. |

The installer merges this entry into `models.json` and points `model_catalog_json` at it, so no manual context setting is needed; native OpenAI models keep their bundled limits. The effective budget covers the whole conversation context, including instructions, messages, and tool results; it is not a maximum output length. These are the project's configured limits, not a live measurement of upstream capacity.

### Muse Spark 1.3 Contributor

[`catalog/muse-model.json`](../catalog/muse-model.json) adds `openrouter/meta/muse-spark-1.3-contributor` with OpenRouter's published **1,048,576-token** context and a 95% effective budget. Reasoning is mandatory upstream, so the entry offers `low` through `max` (default `medium`) and no `none`; it declares no parallel tool calls.

This is Meta's contributor tier: the price is lower because Meta uses prompts and completions to improve its products, and Codex sends file contents and command output with each step. Use it only for code you are willing to share, such as public repositories. OpenRouter routes to it only after you allow endpoints that may train on inputs in your OpenRouter privacy settings.

### Ultra Spark mode

**DeepSeek V4.1 Flash 1017 · Ultra Spark** (`ultra-spark/deepseek-v4.1-flash-1017`) is the same upstream DeepSeek model with [`prompts/ultra-spark.md`](../prompts/ultra-spark.md) added, which makes delegation the default. It splits broad tasks such as reviews across parallel Muse Spark 1.3 Contributor workers, up to 10 at once, and hands them chores such as code searches, test runs, and mechanical edits through Codex's `spawn_agent` tool. Design decisions, final edits, and verification stay in the DeepSeek thread, workers are spawned with `fork_context: false` so they see only their task, and the default reasoning effort is `max`.

Switch it on or off in a thread with `/model`. Workers inherit the [Muse contributor terms](#muse-spark-13-contributor), so use the mode only for code you are willing to share. The router refuses it in a session that already used a native OpenAI model; see [Provider isolation](#provider-isolation).

### Add a model

Native models come from Codex's bundled catalog; update Codex and rerun the installer to refresh them. For an OpenRouter model:

1. Copy [`catalog/deepseek-model.json`](../catalog/deepseek-model.json) to another JSON file in `catalog/`.
2. Set `slug` to `openrouter/<exact-openrouter-model-slug>`.
3. Update the display name, description, context limits, reasoning levels, and other capabilities to match the model.
4. Refresh the prompts with `node scripts/render-openrouter-entries.mjs`, then rerun the installer.

The router removes the `openrouter/` prefix before forwarding. The catalog build fails on a duplicate slug, a slug that matches a bundled Codex model, or a missing prompt file.

Every `deepseek/`, `openrouter/`, and `ultra-spark/` entry uses the maintained instructions in [`prompts/`](../prompts/), which the installer also injects into its generated catalog. An entry can append one more prompt from that directory by naming it in `router_instructions_suffix`, as Ultra Spark does; the generated Codex catalog omits that field.

## Routing

### Routing and compatibility

| Requested model | Upstream service | Upstream model |
| --- | --- | --- |
| `gpt-6-astra` | Native Codex backend | `gpt-6-astra` |
| `deepseek/deepseek-v4.1-flash-1017` | OpenRouter | `deepseek/deepseek-v4.1-flash-1017` |
| `ultra-spark/deepseek-v4.1-flash-1017` | OpenRouter | `deepseek/deepseek-v4.1-flash-1017` |
| `openrouter/meta/muse-spark-1.3-contributor` | OpenRouter | `meta/muse-spark-1.3-contributor` |
| `openrouter/vendor/model` | OpenRouter | `vendor/model` |

The same catalog serves main threads, spawned agents, and any interface that exposes a model field.

- **Reasoning effort:** DeepSeek requests map `medium` to `high`, and values such as `xhigh` and `ultra` to `max`, because DeepSeek accepts only `low`, `high`, `max`, and `none`. Other OpenRouter requests keep the requested effort, which OpenRouter translates for each provider. Native OpenAI requests keep the requested effort.
- **Mixed history:** OpenAI requests omit plaintext reasoning from OpenRouter history while preserving encrypted reasoning, chat messages, tool calls, and tool results.
- **Stateless continuation:** OpenRouter's Responses API does not support stored response state, so the router removes `previous_response_id` and disables `store: true`. Codex continues to send the full conversation history in `input`.
- **Rejected-step recovery:** A pre-stream OpenRouter HTTP 400 that reports a context-window overflow becomes a streamed `context_length_exceeded` failure, so Codex compacts the thread. Other pre-stream 400s get one bounded retry without encrypted reasoning and, for large histories, with a bounded recent tail of the latest turn. If that also fails, the router returns a completed Codex diagnostic response instead of forwarding HTTP 400, preserving the thread.
- **Structured output:** Requests keep the selected model; see [Routing policy](#routing-policy).
- **Streaming:** Responses are piped through as they arrive, and client disconnects cancel unfinished upstream requests.

### Provider isolation

Native OpenAI models and models whose provider trains on their inputs never share a Codex session. Once a session uses one side, the router refuses the other with HTTP 409 (`provider_isolation`) and a message to start a new thread:

| A session that has used | Cannot use |
| --- | --- |
| A native OpenAI model | Muse Spark 1.3 Contributor, Ultra Spark, or another training-tier model |
| Muse Spark 1.3 Contributor or Ultra Spark | A native OpenAI model |

DeepSeek and other OpenRouter models work with either side. Ultra Spark counts as training-tier because its workers run on Muse. Spawned agents share their parent's session, so the rule covers whole agent trees: if a native OpenAI thread spawns a Muse worker, the worker's requests are refused.

The router keeps each session's side, without any content, in `unified-router/session-sides.json`, so the rule survives restarts. A record expires 30 days after the session's last request. There is no opt-out; `CODEX_ROUTER_TRAINING_MODELS` can only add models to the training tier.

The rule follows session IDs, not content, so these start a new record:

- **Forked sessions.** `codex fork` copies a thread's history into a new session. Fork a thread that used native OpenAI models only onto DeepSeek or another neutral model.
- **Sessions from before this router version.** Their first request after the upgrade decides their side.
- **Requests without a session ID**, such as from clients other than Codex, are not tracked.

### Routing policy

The router always forwards the model you selected and never substitutes another, including for structured output. DeepSeek's endpoint rejects JSON schemas, so for DeepSeek a `json_schema` response format becomes JSON mode with the schema appended as the final developer instruction: replies follow the schema, but the provider does not enforce it, and the unchanged history keeps its cache hits. `request.forwarded` logs `structuredOutputAdapted`. Other OpenRouter models receive the schema unchanged.

The `X-Codex-Routing-Policy: preserve-model-v1` header, which the OpenRouter-only profile sends, is still accepted and matches the default behavior. Unknown policy values receive HTTP 400. The policy header and the local token are never forwarded to providers.

### OpenRouter endpoint preferences

OpenRouter chooses an endpoint for each request. To prefer particular endpoints for a model, set `CODEX_ROUTER_PROVIDER_ORDER` in `unified-router/openrouter.env` and restart the router:

```sh
CODEX_ROUTER_PROVIDER_ORDER=deepseek/deepseek-v4.1-flash-1017=deepseek
```

The key is the upstream model slug, without the `openrouter/` prefix; Ultra Spark shares DeepSeek's key. List several endpoints with commas, and separate models with `;`. Endpoint tags come from `https://openrouter.ai/api/v1/models/<model>/endpoints`. The router adds `provider: { order: [...] }` only when the request has no `provider` field. Fallbacks stay enabled, so an outage of the preferred endpoint costs a cache miss instead of failing the turn, and OpenRouter's own sticky routing does not apply while an order is set. A malformed value stops the router at startup; `request.forwarded` logs the applied `providerOrder`.

### OpenRouter-only profile

The installer writes `unified-openrouter.config.toml` beside `config.toml`, with the same local token and catalog. It sets `requires_openai_auth = false`, so OpenRouter models need no ChatGPT login, and sends the `preserve-model-v1` header. Select it with any OpenRouter model in the catalog; Ultra Spark's Muse workers use the same profile:

```sh
codex --profile unified-openrouter --model deepseek/deepseek-v4.1-flash-1017
codex --profile unified-openrouter --model ultra-spark/deepseek-v4.1-flash-1017
codex --profile unified-openrouter --model openrouter/meta/muse-spark-1.3-contributor
```

Use the main configuration for native OpenAI models. The profile supplies transport settings, not prompts, plugins, or task policies, and still inherits your other user and project settings; it is not a sandbox. Codex 0.163.0 does not load it with `--ignore-user-config`. Clients that need isolated execution must manage their own Codex home, instructions, tools, permissions, and output validation.

### Router capabilities

`GET /health` (also `/v1/health`) reports the running router's capabilities and `revision`, the SHA-256 of its source, so clients can check compatibility and spot outdated installed copies without sending an inference request:

| Field | Meaning |
| --- | --- |
| `capabilities.routingPolicies` | Supported routing policies (`preserve-model-v1`). |
| `capabilities.openrouterRejectionRecovery` | The bounded OpenRouter 400 recovery contract. |
| `capabilities.providerIsolation` | The [provider isolation](#provider-isolation) rule (`session-v1`). |
| `capabilities.revisionPrecondition` | Support for the `X-Codex-Router-Revision` header below. |
| `revision` | SHA-256 of the running router source. |

These fields do not attest upstream model identity, account access, or the whole runtime configuration. Clients that need to hold a revision across requests can send:

```http
X-Codex-Router-Revision: <lowercase-sha256-from-health>
```

After local authentication, the router rejects a malformed digest with HTTP 400 and a mismatch with HTTP 409 (`router_revision_mismatch`) before contacting either upstream; a matching or absent header leaves routing unchanged, and the header is never forwarded. Check the capability first, since older routers may ignore the header. The precondition detects a changed source, not a restart of identical code or a service configuration change.

## Credentials and logging

The router binds only to `127.0.0.1`. OpenAI requests carry the incoming Codex authentication to `https://chatgpt.com/backend-api/codex/responses`; OpenRouter requests use the OpenRouter key and go to `https://openrouter.ai/api/v1/responses`.

The OpenRouter key and the local token are stored in `unified-router/openrouter.env` under your Codex home directory, outside this repository. Codex sends the token through its provider `http_headers` setting, and the router removes it before forwarding. Model requests and model listings require the token; the health endpoint does not.

Credential-bearing files, including the OpenRouter-only profile, are private: the Unix installer uses mode `600` and a private router directory, and the Windows installer replaces inherited and explicit access rules with a current-user-only access list before writing or reusing credentials. Backups and temporary installation directories are private too. These permissions do not isolate the files from software running as your own user or an administrator.

The router rejects browser origins, unexpected Host headers, and non-JSON model requests, and its per-provider header allowlists keep unrelated credentials from being forwarded. Request bodies are limited to 64 MiB; this is a local single-user service, not a shared network gateway.

The verifier checks both configurations against the stored token, their managed settings, and private ownership and permissions. Readiness requires the current capabilities and the installed source's SHA-256, so a reachable older router does not pass, and health redirects are rejected.

Logs never include request or response bodies, authorization headers, or API keys. See [Structured logs](operations.md#structured-logs) for log levels, event names, and platform log locations.

## CI coverage

The [workflow](../.github/workflows/ci.yml) runs on pushes, pull requests, and manual dispatch. It tests Linux with Node.js 20, 22, and 24, plus macOS and Windows with Node.js 24, checks JavaScript, Bash, and Windows PowerShell syntax, and validates the model JSON. `node --test` also checks that catalog entries carry the rendered prompts.

Tests use synthetic upstream responses and need no API credentials. Live provider compatibility and background-service installation require separate manual verification.

## License and template provenance

This project is licensed under [Apache-2.0](../LICENSE). [NOTICE](../NOTICE) preserves the applicable OpenAI attribution. This is an independent community project.

The DeepSeek catalog entry includes model-message templates that match the bundled catalog of `@openai/codex` **0.163.0**, whose package metadata declares Apache-2.0. The [adjacent file notice](../catalog/deepseek-model.json.license) identifies those sections and the modifications. The Muse and Ultra Spark entries derive from the same template, as recorded in their notices ([Muse](../catalog/muse-model.json.license), [Ultra Spark](../catalog/deepseek-ultra-spark-model.json.license)). Keep the licenses and applicable notices when redistributing an entry or a modified copy, and record your own changes.

The main and persistent instructions are maintained separately in [`prompts/`](../prompts/). They are not verbatim copies of the corresponding instructions in the installed Codex catalog; this comparison does not establish originality against other sources. Native model entries are read from the user's installed Codex during installation.

The software license does not grant access to models or hosted services. Access to OpenAI, OpenRouter, and each model provider, including Meta's contributor tier, remains subject to their respective service terms.
