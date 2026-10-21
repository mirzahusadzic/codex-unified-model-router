# Contributing

Thanks for helping improve the router. It is deliberately small: a local compatibility layer that fits Codex's existing model picker and thread workflow. Read [AGENTS.md](AGENTS.md) first; it lists where each kind of change belongs and the behaviors every change must preserve.

## Development

Node.js 20 or later is the only requirement; there are no dependencies to install and no build step.

```sh
node --test                                # all tests; offline, no credentials needed
bash -n install.sh scripts/*.sh            # shell syntax
node scripts/render-openrouter-entries.mjs # after editing prompts/ or adding a catalog entry
```

The installed router is a separate copy under your Codex home directory. Rerun the installer to try a change in Codex, and run `./scripts/verify-install.sh` afterward.

## Project layout

| Path | Contents |
| --- | --- |
| `router/unified-router.mjs` | The router: routing, request adaptation, recovery, provider isolation, and streaming. |
| `catalog/` | OpenRouter model entries for the Codex catalog, each with a license notice. |
| `prompts/` | Shared OpenRouter instructions and the Ultra Spark delegation policy. |
| `install.sh`, `install.ps1` | Installers for macOS/Linux and Windows. |
| `scripts/` | Verifiers, installer helpers, and development tools; see [Scripts](#scripts). |
| `tests/` | `node --test` suites, plus a Windows access-control test; see [Tests](#tests). |
| `docs/` | [Setup and configuration](docs/setup.md) and [services and troubleshooting](docs/operations.md). |

### Scripts

Scripts you run:

| Script | Purpose |
| --- | --- |
| `scripts/verify-install.sh`, `scripts/verify-install.ps1` | Verify an installation: configuration, tokens, permissions, catalog prompts, router health, and the service. Pass `--no-service` (Windows: `-NoService`) after an install without a service. |
| `scripts/render-openrouter-entries.mjs` | Render the maintained prompts into the checked-in catalog entries. Run it after editing `prompts/` or adding an entry. |
| `scripts/chatgpt-plan.mjs <codex-home>` | Print `active`, `inactive`, or `unknown` for the ChatGPT plan in Codex's login, as the installer's `CODEX_ROUTER_NATIVE_MODELS=auto` check sees it. |

Helpers the installers and verifiers call:

| Script | Purpose |
| --- | --- |
| `scripts/build-catalog.mjs` | Build `models.json` from Codex's bundled models and `catalog/`, applying prompts, hiding native models on request, and rejecting duplicate or colliding slugs. |
| `scripts/merge-config.mjs` | Merge the managed settings into `config.toml` and the OpenRouter-only profile, preserving everything else. |
| `scripts/prepare-credentials.mjs` | Write `unified-router/openrouter.env`, keeping the local token and any extra router settings. |
| `scripts/config-managed.mjs` | Report through its exit status whether a configuration already has the managed marker, which decides whether `--force` is required. |
| `scripts/verify-credentials.mjs` | Check the managed blocks, local tokens, and private permissions. |
| `scripts/verify-health.mjs` | Check the running router's health, capabilities, and source revision. |
| `scripts/verify-prompts.mjs` | Check that the installed catalog carries the repository's prompts. |
| `scripts/private-path.ps1` | On Windows, restrict a file or directory to the current user. |

Shared modules: `scripts/openrouter-prompts.mjs` holds the prompt rules for OpenRouter entries, and `scripts/toml-lines.mjs` reads TOML line by line without mistaking strings or comments for keys, tables, or markers.

### Tests

`node --test` runs every `.test.mjs` file on macOS, Linux, and Windows; [CI](.github/workflows/ci.yml) covers all three. The tests use synthetic upstreams and need no credentials or network.

| Test file | Covers | Platforms |
| --- | --- | --- |
| `tests/unified-router.test.mjs` | Routing, history repair, reasoning and structured-output adaptation, OpenRouter recovery, provider isolation, endpoint preferences, header allowlists, streaming, and logs. | All |
| `tests/credentials.test.mjs` | Credential files and configuration merging: tokens, managed apps, analytics, and agent settings, and TOML strings and comments. | All |
| `tests/catalog.test.mjs` | Catalog entries, rendered prompts, prompt suffixes, and catalog-build validation. | All |
| `tests/native-models.test.mjs` | ChatGPT plan detection and hiding native models. | All |
| `tests/install.test.mjs` | End-to-end installs without a service, collision guards, and setting validation. Runs `install.sh` on macOS and Linux and `install.ps1` on Windows. | All, per-platform installer |
| `tests/log-level.test.mjs` | Router startup settings: log levels, endpoint preferences, and a corrupt isolation record. | All |
| `tests/verify-health.test.mjs` | The health verifier's capability, revision, and redirect checks. | All |
| `tests/private-path.test.ps1` | Current-user-only access control lists on Windows. CI runs it in a separate step. | Windows |

## Making changes

- **Router behavior:** add a focused regression test in `tests/unified-router.test.mjs`.
- **New OpenRouter model:** copy `catalog/deepseek-model.json`, use `openrouter/<upstream-model-slug>`, and review every capability: context limits, reasoning levels, tool support, and prompts. A catalog entry alone does not prove compatibility, so try the model in Codex before proposing it.
- **Installers:** keep `install.sh` and `install.ps1` aligned, including backups and preservation of unrelated configuration.
- **Documentation:** keep the README brief and put details in `docs/`.

## Pull requests

- Keep each pull request to one focused change, with a [Conventional Commits](https://www.conventionalcommits.org/) message such as `fix:`, `feat:`, or `docs:`.
- Describe how you verified the change, including any live run.
- Never include credentials, router tokens, Codex session files, or captured request bodies.

Report security issues privately as described in [SECURITY.md](SECURITY.md).
