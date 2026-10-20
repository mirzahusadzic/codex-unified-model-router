# Codex Unified Model Router

[![CI](https://github.com/mirzahusadzic/codex-unified-model-router/actions/workflows/ci.yml/badge.svg)](https://github.com/mirzahusadzic/codex-unified-model-router/actions/workflows/ci.yml)

Switch between native OpenAI and OpenRouter models in Codex through a lightweight local router.

- **One setup.** A shared model catalog for main threads and child threads.
- **Switch in place.** Choose models with `/model`, including DeepSeek → OpenAI.
- **Local and lightweight.** Streaming responses, automatic startup, zero npm dependencies.

## Install

Requires Codex CLI (tested with **0.163.0**), **Node.js 20+**, and an **OpenRouter API key**. The default mixed-provider setup uses Codex ChatGPT authentication; users without it can select the [OpenRouter-only profile](docs/setup.md#openrouter-only-profile). macOS/Linux also need `jq` and `curl`.

```sh
git clone https://github.com/mirzahusadzic/codex-unified-model-router.git
cd codex-unified-model-router
export OPENROUTER_API_KEY='your-openrouter-api-key'
./install.sh
./scripts/verify-install.sh
```

<details>
<summary>Windows · PowerShell 5.1+</summary>

```powershell
git clone https://github.com/mirzahusadzic/codex-unified-model-router.git
Set-Location codex-unified-model-router
$env:OPENROUTER_API_KEY = 'your-openrouter-api-key'
.\install.ps1
.\scripts\verify-install.ps1
```

</details>

For an existing Codex configuration, add `--force` (Windows: `-Force`) on the first install. Existing files are backed up.

**Restart Codex and start a new thread after installation.** If you use the shared app-server daemon, [restart it once](docs/setup.md#activate-the-provider) to load the provider.

## Use

```sh
codex -m gpt-6-astra
codex -m deepseek/deepseek-v4.1-flash-1017
```

Use `/model` to switch within a thread. Native OpenAI models use your Codex ChatGPT authentication; `deepseek/*` and `openrouter/*` models route through OpenRouter. By default, structured-output requests on OpenRouter routes fall back to OpenAI.

For OpenRouter without a ChatGPT login, select `--profile unified-openrouter`
with an OpenRouter model. This profile refuses automatic model substitution.
Other callers can opt into the same [routing policy](docs/setup.md#routing-policy)
without changing their authentication setup.

DeepSeek is preconfigured for **960,000 context tokens**, with a **912,000-token effective budget**. [How it is configured →](docs/setup.md#deepseek-context-window)

## Develop

```sh
node --test
```

CI tests Linux, macOS, and Windows, checks script syntax, and validates the model catalog. Tests need no API keys or network access.

---

[Setup & configuration](docs/setup.md) · [Services & troubleshooting](docs/operations.md) · [CI workflow](.github/workflows/ci.yml) · [Apache-2.0](LICENSE) · [Notices](NOTICE)
