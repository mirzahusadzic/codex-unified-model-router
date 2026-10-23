# Repository guide

Keep this project a small local router that fits Codex's existing model picker and thread workflow. Prefer catalog changes and focused compatibility fixes over new CLI commands, frameworks, or runtime dependencies.

## Start here

- [README.md](README.md): installation and everyday usage.
- [docs/setup.md](docs/setup.md): configuration, model catalogs, and context limits.
- [docs/operations.md](docs/operations.md): services, logs, and rollback.
- [CONTRIBUTING.md](CONTRIBUTING.md): project layout and what each script does.
- Development needs Node.js 20+; no dependency install or build step is required. Run `node --test` from the repository root. Tests use fake upstreams and need no credentials or network.

## Common changes

| Task | Source to edit |
| --- | --- |
| Request routing, history normalization, streaming | `router/unified-router.mjs` |
| Add or update an OpenRouter model | `catalog/*.json` |
| Shared OpenRouter prompts | `prompts/openrouter-instructions.md`, `prompts/openrouter-persistent.md` |
| Ultra Spark delegation policy | `prompts/ultra-spark.md` |
| Catalog generation and prompt rendering | `scripts/build-catalog.mjs`, `scripts/openrouter-prompts.mjs` |
| Managed Codex settings and TOML handling | `scripts/merge-config.mjs`, `scripts/toml-lines.mjs` |
| Installation or service startup | `install.mjs` (entry point), `platform/unix/install.sh`, `platform/windows/install.ps1` |
| Codex daemon restart and pinning | `scripts/codex-daemon.mjs` |
| Tested Codex version | `testedCodexVersion` in `install.mjs` and the references in docs; see [Upgrade Codex](#upgrade-codex) |

For a new OpenRouter entry, copy `catalog/deepseek-model.json`, use `openrouter/<upstream-model-slug>`, and review all capabilities: context limits, effective context percentage, reasoning levels, tool support, and prompts. A catalog entry alone does not establish upstream compatibility.

Native OpenAI models come from Codex's bundled catalog. New OpenRouter models normally need no router code change: `openrouter/` is stripped before forwarding, `deepseek/` is preserved, and the `ultra-spark/` alias forwards as `deepseek/` with the Ultra Spark prompt. Other slugs route to the native Codex backend.

After editing the maintained prompts or adding an OpenRouter entry, run `node scripts/render-openrouter-entries.mjs` and include the updated catalog entries. An entry can append one more prompt from `prompts/` by naming it in `router_instructions_suffix`; the generated Codex catalog omits that field. Keep model-specific context settings in the catalog; preserve native models' bundled limits.

## Preserve these behaviors

- Bind the router to loopback. Keep credentials and request/response bodies out of logs and committed files.
- OpenRouter requests replace Codex authentication with the OpenRouter key; native OpenAI requests retain Codex authentication.
- Mixed history preserves messages, tool calls, tool results, and encrypted reasoning while removing unsupported plaintext reasoning from OpenAI requests and native tool declarations (`additional_tools` items) from OpenRouter requests.
- A pre-stream OpenRouter 400 may receive one bounded recovery attempt, but it must never escape as HTTP 400 to Codex. Context-window rejections instead return a streamed `response.failed` with `context_length_exceeded` so Codex compacts the thread. If recovery fails, return a completed router diagnostic while preserving the real rejection in logs and keeping exact bodies out of logs unless capture is explicitly enabled.
- Never substitute a model. Structured output stays on the selected model; for DeepSeek, which rejects JSON schemas, send JSON mode with the schema appended as the final developer instruction.
- Forward response chunks as they arrive and cancel unfinished upstream requests when the client disconnects.
- Muse and the Ultra Spark workers send their inputs to Meta's contributor tier, which trains on them. Keep that explicit in docs and catalog descriptions, keep Ultra Spark spawning workers with `fork_context: false` (as a backstop, the router refuses Muse and other non-Ultra Spark training-tier requests from spawned agents that carry tool call IDs from an Ultra Spark main thread), and never let native OpenAI and training-tier models share a session.
- Keep Codex analytics and the OpenAI-hosted guardian reviewer off by default, and never send router data to third parties.
- Keep Unix and Windows installation behavior aligned, including backups and preservation of unrelated configuration.
- Pin the Codex app-server daemon to the CLI's Codex by default, and never restart it when Codex runs the installer or when restarts are turned off.

## Upgrade Codex

The tested version is `testedCodexVersion` in `install.mjs`. The installer pins the app-server daemon to the CLI's Codex; unpinned, the daemon updates itself and can run a new release before the CLI does, so compare `codex --version` with `codex app-server daemon version`.

1. Diff `rust-v<old>..rust-v<new>` in `openai/codex` for what the router relies on: the `session-id` and `thread-id` headers (a main thread's ID equals its session ID), the native header allowlist in `upstreamHeaders`, request fields and input item types, `spawn_agent`'s `fork_context`, the keys `scripts/merge-config.mjs` writes, guardian gating, and the `codex app-server daemon` `version`, `restart`, and `update --from-cli` commands with the `auto-update-version` marker that `scripts/codex-daemon.mjs` checks.
2. Compare `codex debug models --bundled` from both versions with `CODEX_HOME` set to a scratch directory. If templates changed, update the catalog entries, their `.license` files, and `NOTICE`.
3. In a scratch `CODEX_HOME`, point a provider at a local capture server and compare what both versions send for a fresh OpenRouter thread and for a thread that switches from a native model to an OpenRouter model. Then send the same turns through the installed router with `codex exec -c model_provider=...`. Resume by session ID, because `resume --last` does not find a session recorded under another provider. Pass `-m` explicitly and keep test traffic off Muse and Ultra Spark.
4. Fix incompatibilities in the router with a regression test. Update every tested-version reference, including escaped ones in test regexes such as `0\.163\.0` (`git grep -n 163` finds both forms), but keep statements about the version that introduced a behavior. With the new CLI installed, run `node --test`: `tests/prompt-budget.test.mjs` fails when Codex changes the tools, request size, or features it turns on for router models, so review each change before updating its expectations. Then run the installer and `node install.mjs --verify`.
5. Tag the verified commit `codex-<new>` with `git tag -a`; it is the fallback in [Return to an earlier Codex version](docs/operations.md#return-to-an-earlier-codex-version). A tag marks the last commit verified with its Codex version, so move it with `git tag -f -a` when a later commit passes the same checks, and before raising the pin make sure `codex-<old>` points at the last commit verified with the old version. Tags stay local until pushed.

## Validate and document

For router behavior changes, add a focused regression test in `tests/unified-router.test.mjs` and run `node --test`. For shell edits, run `bash -n` on each changed script. `node --test` also checks that catalog entries carry the rendered prompts; CI additionally checks JavaScript and Windows PowerShell syntax and model JSON; see [.github/workflows/ci.yml](.github/workflows/ci.yml).

Keep the README brief. Put detailed setup and troubleshooting in `docs/`. Documentation-only changes need link and factual checks, not a full test run.

Edit repository sources first. The running router uses a separate installed copy under the Codex home directory; source edits do not update it. Run installers or restart services when deployment is part of the task. Installation changes live configuration and restarts the router and a running Codex app-server daemon, which interrupts active requests and sessions. Use the documented verifier afterward; local health does not prove upstream model access.
