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
