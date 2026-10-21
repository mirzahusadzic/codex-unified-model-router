# Codex Unified Model Router

[![CI](https://github.com/mirzahusadzic/codex-unified-model-router/actions/workflows/ci.yml/badge.svg)](https://github.com/mirzahusadzic/codex-unified-model-router/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![Node.js 20+](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![Codex CLI 0.163](https://img.shields.io/badge/Codex%20CLI-0.163-111111)
![macOS · Linux · Windows](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-lightgrey)
![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)

Run Codex on DeepSeek, Meta Muse, or any OpenRouter model, and switch between them in the middle of a thread, through a small local router.

- **DeepSeek by default.** DeepSeek V4.1 Flash 1017 with a 960,000-token context. Prompts stay cache-friendly, so long agent sessions read most of each prompt from cache.
- **Ultra Spark mode.** DeepSeek leads and up to 10 Muse workers handle reviews, searches, and test runs in parallel; DeepSeek checks their findings before it reports them.
- **Switch in place.** `/model` moves a thread between DeepSeek, Muse, any `openrouter/<model>`, and native OpenAI models. Tool calls and reasoning history are repaired for each provider.
- **Hard to break.** A rejected request gets one bounded retry, a context overflow triggers Codex's compaction instead of a dead thread, and requests never silently switch to another model.
- **Lean.** The installer turns off Codex's ChatGPT connector tools, about 65,000 tokens per request, and allows 10 parallel agents. Loopback only, streaming, zero npm dependencies.

## How it works

```mermaid
flowchart LR
    codex["Codex CLI and app-server"] -->|"Responses API with a local token"| router["Unified router on 127.0.0.1"]
    router -->|"deepseek/, ultra-spark/, openrouter/"| openrouter["OpenRouter"]
    router -->|"other models, with your ChatGPT login"| openai["ChatGPT Codex backend"]
    openrouter --> deepseek["DeepSeek V4.1 Flash"]
    openrouter --> muse["Muse Spark 1.3"]
    openrouter --> more["Any OpenRouter model"]
```

Codex talks to the router as one model provider. The router picks the upstream from the model slug, adapts each request to that provider, and streams the response back unchanged.

## Install

Requires Codex CLI (tested with **0.163.0**), **Node.js 20+**, and an **OpenRouter API key**. macOS/Linux also need `jq`.

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

For an existing Codex configuration, add `--force` (Windows: `-Force`) on the first install. Existing files are backed up. Native OpenAI models are hidden from `/model` when Codex's login shows no active ChatGPT plan; set `CODEX_ROUTER_NATIVE_MODELS=show` or `hide` to override ([details](docs/setup.md#native-openai-models)). To keep the ChatGPT connector tools or Codex's own agent limit, install with `CODEX_ROUTER_DISABLE_APPS=0` or `CODEX_ROUTER_AGENT_THREADS=0` ([details](docs/setup.md#chatgpt-apps)).

**Start a new thread after installation.** The installer restarts a running Codex app-server daemon for you; restart other open Codex windows yourself ([details](docs/setup.md#activate-the-provider)).

## Use

```sh
codex                                                   # DeepSeek V4.1 Flash 1017
codex -m ultra-spark/deepseek-v4.1-flash-1017   # Ultra Spark mode
codex -m openrouter/meta/muse-spark-1.3-contributor     # Muse Spark 1.3 Contributor
```

| Model | Best for |
| --- | --- |
| **DeepSeek V4.1 Flash 1017** (default) | Everyday agentic coding with a long context. [Details](docs/setup.md#deepseek-context-window) |
| **DeepSeek · Ultra Spark** | Broad tasks such as reviews, audits, and changes across many files. [Details](docs/setup.md#ultra-spark-mode) |
| **Muse Spark 1.3 Contributor** | Fast, inexpensive work on public code. [Details](docs/setup.md#muse-spark-13-contributor) |
| **Any `openrouter/<vendor>/<model>`** | Trying another model; [add a catalog entry](docs/setup.md#add-a-model) to list it in `/model`. |
| **Native OpenAI**, such as `gpt-6-astra` | Requires a ChatGPT plan. |

Muse and the Ultra Spark workers use Meta's contributor tier, which trains on everything it receives. Use them only for code you are willing to share, and start Ultra Spark in a fresh thread.

Without a ChatGPT login, add `--profile unified-openrouter` to any of the commands above, Ultra Spark included ([details](docs/setup.md#openrouter-only-profile)). To prefer specific OpenRouter endpoints, set [`CODEX_ROUTER_PROVIDER_ORDER`](docs/setup.md#openrouter-endpoint-preferences).

## Develop

```sh
node --test
```

CI tests Linux, macOS, and Windows, checks script syntax, and validates the model catalog. Tests need no API keys or network access.

---

[Setup & configuration](docs/setup.md) · [Services & troubleshooting](docs/operations.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Apache-2.0](LICENSE) · [Notices](NOTICE)
