[CmdletBinding()]
param(
    [switch]$NoService
)

$ErrorActionPreference = 'Stop'

$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$ConfigPath = Join-Path $CodexHome 'config.toml'
$ModelsPath = Join-Path $CodexHome 'models.json'
$RouterPath = Join-Path $CodexHome 'unified-router\router.mjs'
$StartCmd = Join-Path $CodexHome 'unified-router\start-router.cmd'
$StartupScript = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Unified Router.vbs'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

$RequiredPaths = @($ConfigPath, $ModelsPath, $RouterPath)
if (-not $NoService) {
    $RequiredPaths += @($StartCmd, $StartupScript)
}

foreach ($Path in $RequiredPaths) {
    if (-not (Test-Path $Path)) { throw "Missing required file: $Path" }
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
if ($DeepSeek.base_instructions -ne $DeepSeek.model_messages.instructions_template) {
    throw 'DeepSeek instruction representations differ.'
}

if (-not $NoService) {
    $Health = Invoke-RestMethod -Uri 'http://127.0.0.1:18766/health' -TimeoutSec 2
    if (-not ($Health.ok -and $Health.openai -and $Health.openrouter)) {
        throw 'The unified router health check failed.'
    }
}

Write-Host 'Install looks valid.'
Write-Host 'Default main model: gpt-6-astra'
Write-Host 'Selectable models: gpt-6-astra, deepseek/deepseek-v4.1-flash-1017, and the rest of the catalog.'
