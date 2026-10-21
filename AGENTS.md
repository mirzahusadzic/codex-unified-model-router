# Repository guide

Keep this project a small local router that fits Codex's existing model picker and thread workflow. Prefer catalog changes and focused compatibility fixes over new CLI commands, frameworks, or runtime dependencies.

## Start here

- [README.md](README.md): installation and everyday usage.
- [docs/setup.md](docs/setup.md): configuration, model catalogs, and context limits.
- [docs/operations.md](docs/operations.md): services, logs, and rollback.
- Development needs Node.js 20+; no dependency install or build step is required. Run `node --test` from the repository root. Tests use fake upstreams and need no credentials or network.

## Common changes

| Task | Source to edit |
| --- | --- |
| Request routing, history normalization, streaming | `router/unified-router.mjs` |
| Add or update an OpenRouter model | `catalog/*.json` |
| Shared OpenRouter prompts | `prompts/openrouter-instructions.md`, `prompts/openrouter-persistent.md` |
| Catalog generation or managed Codex settings | `scripts/build-catalog.mjs`, `scripts/merge-config.mjs` |
| Installation or service startup | `install.sh`, `install.ps1` |

For a new OpenRouter entry, copy `catalog/deepseek-model.json`, use `openrouter/<upstream-model-slug>`, and review all capabilities: context limits, effective context percentage, reasoning levels, tool support, and prompts. A catalog entry alone does not establish upstream compatibility.

Native OpenAI models come from Codex's bundled catalog. New OpenRouter models normally need no router code change: `openrouter/` is stripped before forwarding, while `deepseek/` is preserved. Other slugs route to the native Codex backend.

After editing the maintained prompts, run `./scripts/render-openrouter-entries.sh` (requires `jq`) and include the updated catalog entries. Keep model-specific context settings in the catalog; preserve native models' bundled limits.

## Preserve these behaviors

- Bind the router to loopback. Keep credentials and request/response bodies out of logs and committed files.
- OpenRouter requests replace Codex authentication with the OpenRouter key; native OpenAI requests retain Codex authentication.
- Mixed history preserves messages, tool calls, tool results, and encrypted reasoning while removing unsupported plaintext reasoning from OpenAI requests.
- A pre-stream OpenRouter 400 may receive one bounded recovery attempt, but it must never escape as HTTP 400 to Codex. Context-window rejections instead return a streamed `response.failed` with `context_length_exceeded` so Codex compacts the thread. If recovery fails, return a completed router diagnostic while preserving the real rejection in logs and keeping exact bodies out of logs unless capture is explicitly enabled.
- Structured-output requests on OpenRouter routes use a native OpenAI fallback by default. Requests with `X-Codex-Routing-Policy: preserve-model-v1` must fail instead of substituting a model.
- Forward response chunks as they arrive and cancel unfinished upstream requests when the client disconnects.
- Keep Unix and Windows installation behavior aligned, including backups and preservation of unrelated configuration.

## Validate and document

For router behavior changes, add a focused regression test in `tests/unified-router.test.mjs` and run `node --test`. For shell edits, run `bash -n` on each changed script. CI also checks JavaScript and Windows PowerShell syntax, model JSON, and prompt consistency; see [.github/workflows/ci.yml](.github/workflows/ci.yml).

Keep the README brief. Put detailed setup and troubleshooting in `docs/`. Documentation-only changes need link and factual checks, not a full test run.

Edit repository sources first. The running router uses a separate installed copy under the Codex home directory; source edits do not update it. Run installers or restart services when deployment is part of the task. Installation changes live configuration, and restarts interrupt active requests. Use the documented verifier afterward; local health does not prove upstream model access.
