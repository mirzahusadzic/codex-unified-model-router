[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$NoService
)

$ErrorActionPreference = 'Stop'

$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $RepoDir 'scripts\private-path.ps1')
$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir = Join-Path $CodexHome "backups\codex-unified-router-$Stamp-$PID"
$RouterDir = Join-Path $CodexHome 'unified-router'
$RouterFile = Join-Path $RouterDir 'router.mjs'
$RouterEnv = Join-Path $RouterDir 'openrouter.env'
$RouterLog = Join-Path $RouterDir 'router.log'
$RouterErrorLog = Join-Path $RouterDir 'router.error.log'
$ExistingConfig = Join-Path $CodexHome 'config.toml'
$StartCmd = Join-Path $RouterDir 'start-router.cmd'
$StartupName = 'Codex Unified Router.vbs'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Fail-Install([string]$Message, [int]$Code = 1) {
    [Console]::Error.WriteLine("Error: $Message")
    exit $Code
}

foreach ($CommandName in @('codex', 'node')) {
    if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
        Fail-Install "Required command not found: $CommandName"
    }
}

$HasStoredKey = Test-Path $RouterEnv
if ([string]::IsNullOrWhiteSpace($env:OPENROUTER_API_KEY) -and -not $HasStoredKey) {
    Fail-Install "OpenRouter is not configured. Set OPENROUTER_API_KEY before installing, or create $RouterEnv."
}

$Managed = $false
if (Test-Path $ExistingConfig) {
    $Managed = Select-String -Path $ExistingConfig -Pattern '# BEGIN codex-unified-router managed keys' -Quiet
}
if (-not $Force -and (Test-Path $ExistingConfig) -and -not $Managed) {
    Fail-Install "An existing Codex configuration was found in $CodexHome. Rerun with -Force for the first conversion." 2
}

New-Item -ItemType Directory -Force -Path $CodexHome, $BackupDir, $RouterDir | Out-Null
Set-PrivatePath $BackupDir
Set-PrivatePath $RouterDir
foreach ($SensitiveFile in @($ExistingConfig, $RouterEnv)) {
    if (Test-Path -LiteralPath $SensitiveFile) { Set-PrivatePath $SensitiveFile }
}
foreach ($Name in @('config.toml', 'deepseek.config.toml', 'models.json')) {
    $ExistingFile = Join-Path $CodexHome $Name
    if (Test-Path $ExistingFile) {
        Copy-Item -Force $ExistingFile (Join-Path $BackupDir $Name)
    }
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-unified-router-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
Set-PrivatePath $TempDir

try {
    $BundledFile = Join-Path $TempDir 'bundled-models.json'
    $BundledText = (& codex debug models --bundled) -join "`n"
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($BundledText)) {
        throw 'Could not read the Codex bundled model catalog.'
    }
    [System.IO.File]::WriteAllText($BundledFile, $BundledText + "`n", $Utf8NoBom)

    $ModelsFile = Join-Path $TempDir 'models.json'
    & node (Join-Path $RepoDir 'scripts\build-catalog.mjs') `
        '--bundled' $BundledFile `
        '--catalog-dir' (Join-Path $RepoDir 'catalog') `
        '--instructions' (Join-Path $RepoDir 'prompts\deepseek-instructions.md') `
        '--persistent' (Join-Path $RepoDir 'prompts\deepseek-persistent.md') `
        '--output' $ModelsFile
    if ($LASTEXITCODE -ne 0) { throw 'Catalog merge failed.' }

    $ConfigOut = Join-Path $TempDir 'config.toml'
    & node (Join-Path $RepoDir 'scripts\prepare-credentials.mjs') $RouterEnv
    if ($LASTEXITCODE -ne 0) { throw 'Router credential setup failed.' }
    Set-PrivatePath $RouterEnv
    & node (Join-Path $RepoDir 'scripts\merge-config.mjs') $ExistingConfig $CodexHome $ConfigOut $RouterEnv
    if ($LASTEXITCODE -ne 0) { throw 'Codex config merge failed.' }

    $CatalogText = [System.IO.File]::ReadAllText($ModelsFile, $Utf8NoBom)
    $Catalog = $CatalogText | ConvertFrom-Json
    $DeepSeek = $Catalog.models | Where-Object { $_.slug -eq 'deepseek/deepseek-v4.1-flash-1017' }
    if (-not $DeepSeek -or [int64]$DeepSeek.context_window -ne 960000) {
        throw 'The generated catalog is missing the expected DeepSeek entry.'
    }

    if (-not (Test-Path -LiteralPath $ExistingConfig)) {
        [System.IO.File]::WriteAllText($ExistingConfig, '', $Utf8NoBom)
    }
    Set-PrivatePath $ExistingConfig
    [System.IO.File]::WriteAllText($ExistingConfig, [System.IO.File]::ReadAllText($ConfigOut, $Utf8NoBom), $Utf8NoBom)
    Copy-Item -Force $ModelsFile (Join-Path $CodexHome 'models.json')
    Copy-Item -Force (Join-Path $RepoDir 'router\unified-router.mjs') $RouterFile

    $LegacyProfile = Join-Path $CodexHome 'deepseek.config.toml'
    if (Test-Path $LegacyProfile) {
        Move-Item -Force $LegacyProfile (Join-Path $BackupDir 'deepseek.config.toml.retired')
    }

    if (-not $NoService) {
        $NodeExe = (Get-Command node).Source
        $CatalogPath = Join-Path $CodexHome 'models.json'
        $CmdContent = @"
@echo off
chcp 65001 >nul
set "CODEX_ROUTER_ENV_FILE=$RouterEnv"
set "CODEX_MODEL_CATALOG=$CatalogPath"
set "CODEX_ROUTER_PORT=18766"
set "CODEX_ROUTER_STRUCTURED_MODEL=gpt-6-astra"
:run
"$NodeExe" "$RouterFile" >> "$RouterLog" 2>> "$RouterErrorLog"
if not errorlevel 1 goto :eof
ping -n 3 127.0.0.1 >nul
goto run
"@
        $CmdContent = $CmdContent -replace "`r?`n", "`r`n"
        [System.IO.File]::WriteAllText($StartCmd, $CmdContent, $Utf8NoBom)

        $StartupDir = [Environment]::GetFolderPath('Startup')
        New-Item -ItemType Directory -Force -Path $StartupDir | Out-Null
        $StartupScript = Join-Path $StartupDir $StartupName
        $EscapedStartCmd = $StartCmd.Replace('"', '""')
        $VbsContent = 'Set shell = CreateObject("WScript.Shell")' + "`r`n" +
            'shell.Run Chr(34) & "' + $EscapedStartCmd + '" & Chr(34), 0, False' + "`r`n"
        [System.IO.File]::WriteAllText($StartupScript, $VbsContent, $Utf8NoBom)

        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -and (
                    $_.CommandLine.Contains($RouterFile) -or
                    $_.CommandLine.Contains($StartCmd) -or
                    $_.CommandLine.Contains($StartupScript)
                )
            } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

        Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList "`"$StartupScript`""

        $Healthy = $false
        for ($Attempt = 0; $Attempt -lt 25; $Attempt += 1) {
            try {
                $Health = Invoke-RestMethod -Uri 'http://127.0.0.1:18766/health' -TimeoutSec 2
                if ($Health.ok -and $Health.openai -and $Health.openrouter -and $Health.clientAuth) {
                    $Healthy = $true
                    break
                }
            } catch {
            }
            Start-Sleep -Milliseconds 200
        }
        if (-not $Healthy) {
            throw "The unified router was installed but did not become healthy. Check $RouterErrorLog."
        }
    }
}
finally {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
}

Write-Host "Installed the Codex unified router in $CodexHome"
Write-Host "Backups: $BackupDir"
Write-Host ''
Write-Host 'Main thread, OpenAI:   codex -m gpt-6-astra'
Write-Host 'Main thread, DeepSeek: codex -m deepseek/deepseek-v4.1-flash-1017'
Write-Host ''
Write-Host 'Restart Codex windows created before this install; they keep the provider they were started with.'
