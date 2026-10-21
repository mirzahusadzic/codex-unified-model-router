[CmdletBinding()]
param(
    [switch]$NoService
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'private-path.ps1')

$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$ConfigPath = Join-Path $CodexHome 'config.toml'
$ProfilePath = Join-Path $CodexHome 'unified-openrouter.config.toml'
$ModelsPath = Join-Path $CodexHome 'models.json'
$RouterPath = Join-Path $CodexHome 'unified-router\router.mjs'
$StartCmd = Join-Path $CodexHome 'unified-router\start-router.cmd'
$StartupScript = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Unified Router.vbs'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

$RequiredPaths = @($ConfigPath, $ProfilePath, $ModelsPath, $RouterPath)
if (-not $NoService) {
    $RequiredPaths += @($StartCmd, $StartupScript)
}

foreach ($Path in $RequiredPaths) {
    if (-not (Test-Path $Path)) { throw "Missing required file: $Path" }
}

& node (Join-Path $PSScriptRoot 'verify-credentials.mjs') $CodexHome
if ($LASTEXITCODE -ne 0) { throw 'Router credential verification failed.' }
foreach ($Path in @($ConfigPath, $ProfilePath, (Join-Path $CodexHome 'unified-router'), (Join-Path $CodexHome 'unified-router\openrouter.env'))) {
    Assert-PrivatePath $Path
}

$Config = [System.IO.File]::ReadAllText($ConfigPath, $Utf8NoBom)
foreach ($Expected in @(
    '# BEGIN codex-unified-router managed keys',
    'model_provider = "unified"',
    '[model_providers.unified]',
    'requires_openai_auth = true',
    'supports_websockets = false'
)) {
    if (-not $Config.Contains($Expected)) { throw "Config is missing: $Expected" }
}

$CatalogText = [System.IO.File]::ReadAllText($ModelsPath, $Utf8NoBom)
$Catalog = $CatalogText | ConvertFrom-Json
$DeepSeek = $Catalog.models | Where-Object { $_.slug -eq 'deepseek/deepseek-v4.1-flash-1017' }
if (-not $DeepSeek) { throw 'DeepSeek is missing from the model catalog.' }
if ([int64]$DeepSeek.context_window -ne 960000 -or [int64]$DeepSeek.max_context_window -ne 960000) {
    throw 'DeepSeek context limits are not 960000.'
}
& node (Join-Path $PSScriptRoot 'verify-prompts.mjs') $CodexHome
if ($LASTEXITCODE -ne 0) { throw 'Installed OpenRouter prompts differ from the repository; rerun the installer.' }

if (-not $NoService) {
    & node (Join-Path $PSScriptRoot 'verify-health.mjs') $RouterPath 'http://127.0.0.1:18766/health'
    if ($LASTEXITCODE -ne 0) {
        throw 'The unified router health check failed.'
    }
}

Write-Host 'Install looks valid.'
Write-Host 'Default main model: gpt-6-astra'
Write-Host 'Selectable models: gpt-6-astra, deepseek/deepseek-v4.1-flash-1017, openrouter/meta/muse-spark-1.3-contributor, openrouter/deepseek/deepseek-v4.1-flash-1017 (Ultra Spark), and the rest of the catalog.'
