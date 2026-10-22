[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$NoService,
    [string]$ApiKeyFile
)

$ErrorActionPreference = 'Stop'

$PlatformDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = Split-Path -Parent (Split-Path -Parent $PlatformDir)
. (Join-Path $PlatformDir 'private-path.ps1')
$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir = Join-Path $CodexHome "backups\codex-unified-router-$Stamp-$PID"
$RouterDir = Join-Path $CodexHome 'unified-router'
$RouterFile = Join-Path $RouterDir 'router.mjs'
$RouterEnv = Join-Path $RouterDir 'openrouter.env'
$RouterLog = Join-Path $RouterDir 'router.log'
$RouterErrorLog = Join-Path $RouterDir 'router.error.log'
$ExistingConfig = Join-Path $CodexHome 'config.toml'
$OpenRouterProfile = Join-Path $CodexHome 'unified-openrouter.config.toml'
$StartCmd = Join-Path $RouterDir 'start-router.cmd'
$StartupName = 'Codex Unified Router.vbs'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Fail-Install([string]$Message, [int]$Code = 1) {
    [Console]::Error.WriteLine("Error: $Message")
    exit $Code
}

$RestartDaemon = if ($env:CODEX_ROUTER_RESTART_DAEMON) { $env:CODEX_ROUTER_RESTART_DAEMON } else { '1' }
if ($RestartDaemon -notin @('0', '1')) {
    Fail-Install 'CODEX_ROUTER_RESTART_DAEMON must be 0 or 1' 2
}
$NativeModels = if ($env:CODEX_ROUTER_NATIVE_MODELS) { $env:CODEX_ROUTER_NATIVE_MODELS } else { 'auto' }
if ($NativeModels -notin @('auto', 'show', 'hide')) {
    Fail-Install 'CODEX_ROUTER_NATIVE_MODELS must be auto, show, or hide' 2
}

foreach ($CommandName in @('codex', 'node')) {
    if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
        Fail-Install "Required command not found: $CommandName"
    }
}

# Merging into a configuration the router does not manage yet needs consent:
# a yes at the prompt, or -Force where no terminal is available. Only a real
# marker line counts as managed, never one inside a TOML string or comment.
$ConfigManaged = Join-Path $RepoDir 'scripts\config-managed.mjs'
$Unmanaged = @()
foreach ($ConfigFile in @($ExistingConfig, $OpenRouterProfile)) {
    if (Test-Path -LiteralPath $ConfigFile) {
        & node $ConfigManaged $ConfigFile
        if ($LASTEXITCODE -ne 0) { $Unmanaged += $ConfigFile }
    }
}
if (-not $Force -and $Unmanaged.Count -gt 0) {
    if ([Console]::IsInputRedirected) {
        Fail-Install "Existing Codex configuration found: $($Unmanaged -join ', '). Run the installer in a terminal to confirm merging into it, or pass -Force. The files are backed up first." 2
    }
    Write-Host 'Existing Codex configuration found:'
    $Unmanaged | ForEach-Object { Write-Host "  $_" }
    Write-Host 'The installer backs these files up, then adds its settings and keeps everything else.'
    $Answer = Read-Host 'Merge into them? [y/N]'
    if ($Answer -notmatch '^(?i)(y|yes)$') { Fail-Install 'Nothing was changed.' 2 }
    $Force = [switch]$true
}

# The OpenRouter key comes from -ApiKeyFile, OPENROUTER_API_KEY, or the stored
# key; otherwise ask for it without echoing. It never appears in a command
# line, where other processes could read it.
$PromptedKey = $null
if ($ApiKeyFile -and -not (Test-Path -LiteralPath $ApiKeyFile -PathType Leaf)) {
    Fail-Install "API key file not found: $ApiKeyFile" 2
}
if (-not $ApiKeyFile -and [string]::IsNullOrWhiteSpace($env:OPENROUTER_API_KEY) -and -not (Test-Path $RouterEnv)) {
    if ([Console]::IsInputRedirected) {
        Fail-Install 'No OpenRouter API key. Run the installer in a terminal to be prompted for it, or pass -ApiKeyFile <path>.'
    }
    Write-Host 'Enter your OpenRouter API key (create one at https://openrouter.ai/keys).'
    Write-Host 'Typing is hidden: paste the key and press Enter.'
    $SecureKey = Read-Host 'OpenRouter API key' -AsSecureString
    $KeyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureKey)
    try { $PromptedKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($KeyPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($KeyPointer) }
    if ([string]::IsNullOrWhiteSpace($PromptedKey)) { Fail-Install 'No OpenRouter API key entered.' }
}

function Write-Step([string]$Message) { [Console]::Error.WriteLine("==> $Message") }

Write-Step "Installing the Codex unified router into $CodexHome"
if ($PromptedKey) { Write-Step 'Using the OpenRouter API key you entered' }
elseif ($ApiKeyFile) { Write-Step "Reading the OpenRouter API key from $ApiKeyFile" }
elseif (-not [string]::IsNullOrWhiteSpace($env:OPENROUTER_API_KEY)) { Write-Step 'Using the OpenRouter API key from OPENROUTER_API_KEY' }
else { Write-Step 'Using the stored OpenRouter API key' }

Write-Step "Backing up the current configuration to $BackupDir"
New-Item -ItemType Directory -Force -Path $CodexHome, $BackupDir, $RouterDir | Out-Null
Set-PrivatePath $BackupDir
Set-PrivatePath $RouterDir
foreach ($SensitiveFile in @($ExistingConfig, $OpenRouterProfile, $RouterEnv)) {
    if (Test-Path -LiteralPath $SensitiveFile) { Set-PrivatePath $SensitiveFile }
}
foreach ($Name in @('config.toml', 'deepseek.config.toml', 'unified-openrouter.config.toml', 'models.json')) {
    $ExistingFile = Join-Path $CodexHome $Name
    if (Test-Path $ExistingFile) {
        Copy-Item -Force $ExistingFile (Join-Path $BackupDir $Name)
    }
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-unified-router-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
Set-PrivatePath $TempDir

try {
    Write-Step 'Building the model catalog'
    $BundledFile = Join-Path $TempDir 'bundled-models.json'
    $BundledText = (& codex debug models --bundled) -join "`n"
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($BundledText)) {
        throw 'Could not read the Codex bundled model catalog.'
    }
    [System.IO.File]::WriteAllText($BundledFile, $BundledText + "`n", $Utf8NoBom)

    # Native OpenAI models need a ChatGPT plan. In auto mode, hide them from /model
    # only when Codex's login shows a missing or lapsed plan.
    if ($NativeModels -eq 'auto') {
        $PlanStatus = & node (Join-Path $RepoDir 'scripts\chatgpt-plan.mjs') $CodexHome
        $NativeModels = if ($PlanStatus -eq 'inactive') { 'hide' } else { 'show' }
    }

    $ModelsFile = Join-Path $TempDir 'models.json'
    & node (Join-Path $RepoDir 'scripts\build-catalog.mjs') `
        '--bundled' $BundledFile `
        '--catalog-dir' (Join-Path $RepoDir 'catalog') `
        '--instructions' (Join-Path $RepoDir 'prompts\openrouter-instructions.md') `
        '--persistent' (Join-Path $RepoDir 'prompts\openrouter-persistent.md') `
        '--native-models' $NativeModels `
        '--output' $ModelsFile
    if ($LASTEXITCODE -ne 0) { throw 'Catalog merge failed.' }
    if ($NativeModels -eq 'hide') { Write-Step 'Native OpenAI models are hidden from /model' }

    Write-Step 'Updating the Codex configuration'
    $ConfigOut = Join-Path $TempDir 'config.toml'
    $PrepareCredentials = Join-Path $RepoDir 'scripts\prepare-credentials.mjs'
    if ($PromptedKey) {
        $PromptedKey | & node $PrepareCredentials $RouterEnv --api-key-stdin
        $PromptedKey = $null
    } elseif ($ApiKeyFile) {
        & node $PrepareCredentials $RouterEnv --api-key-file $ApiKeyFile
    } else {
        & node $PrepareCredentials $RouterEnv
    }
    if ($LASTEXITCODE -ne 0) { throw 'Router credential setup failed.' }
    Set-PrivatePath $RouterEnv
    $OpenRouterOut = Join-Path $TempDir 'unified-openrouter.config.toml'
    $MergeFlags = @()
    if ($Force) { $MergeFlags += '--force' }
    & node (Join-Path $RepoDir 'scripts\merge-config.mjs') $ExistingConfig $CodexHome $ConfigOut $RouterEnv $OpenRouterOut @MergeFlags
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
    if (-not (Test-Path -LiteralPath $OpenRouterProfile)) {
        [System.IO.File]::WriteAllText($OpenRouterProfile, '', $Utf8NoBom)
    }
    Set-PrivatePath $OpenRouterProfile
    [System.IO.File]::WriteAllText($OpenRouterProfile, [System.IO.File]::ReadAllText($OpenRouterOut, $Utf8NoBom), $Utf8NoBom)
    Write-Step 'Installing the router'
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

        Write-Step 'Starting the router and checking its health'
        $Healthy = $false
        for ($Attempt = 0; $Attempt -lt 25; $Attempt += 1) {
            try {
                & node (Join-Path $RepoDir 'scripts\verify-health.mjs') $RouterFile 'http://127.0.0.1:18766/health' 2>$null
                if ($LASTEXITCODE -eq 0) {
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

        # The shared app-server daemon keeps the configuration and catalog it
        # started with. Restarting it interrupts its open sessions, so skip it
        # when it is not running, when Codex itself runs this installer, or
        # when asked not to.
        $DaemonState = $null
        if ($RestartDaemon -eq '1') {
            try { $DaemonState = ((& codex app-server daemon version 2>$null) -join "`n" | ConvertFrom-Json).status } catch { }
        }
        if ($DaemonState -eq 'running') {
            $RunByDaemon = $false
            $Ancestor = $PID
            for ($Depth = 0; $Depth -lt 64 -and $Ancestor; $Depth += 1) {
                $Process = Get-CimInstance Win32_Process -Filter "ProcessId=$Ancestor" -ErrorAction SilentlyContinue
                if (-not $Process) { break }
                if ($Process.CommandLine -and $Process.CommandLine -match '(?i)(^|[\\/"])codex(\.exe)?"?\s+app-server(\s|$)') { $RunByDaemon = $true; break }
                if ($Process.ParentProcessId -eq $Ancestor) { break }
                $Ancestor = $Process.ParentProcessId
            }
            if ($RunByDaemon) {
                [Console]::Error.WriteLine('Codex is running this installer, so its daemon was not restarted. Afterwards run: codex app-server daemon restart')
            } else {
                Write-Step 'Restarting the Codex app-server daemon'
                & codex app-server daemon restart *> $null
                if ($LASTEXITCODE -eq 0) {
                    Write-Host 'Restarted the Codex app-server daemon.'
                } else {
                    [Console]::Error.WriteLine('Could not restart the Codex app-server daemon. Run: codex app-server daemon restart')
                }
            }
        }
    }
}
finally {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
}

Write-Host "Installed the Codex unified router in $CodexHome"
Write-Host "Backups: $BackupDir"
Write-Host ''
Write-Host 'Main thread, DeepSeek: codex (default; or codex -m deepseek/deepseek-v4.1-flash-1017)'
if ($NativeModels -eq 'hide') {
    Write-Host 'Native OpenAI models:  hidden from /model (no active ChatGPT plan, or CODEX_ROUTER_NATIVE_MODELS=hide)'
} else {
    Write-Host 'Main thread, OpenAI:   codex -m gpt-6-astra (requires a ChatGPT plan)'
}
Write-Host 'Main thread, Muse:     codex -m openrouter/meta/muse-spark-1.3-contributor (Meta trains on its prompts; share-safe code only)'
Write-Host 'Ultra Spark mode:      codex -m ultra-spark/deepseek-v4.1-flash-1017 (DeepSeek delegating to Muse workers; fresh threads, share-safe code)'
Write-Host ''
Write-Host 'Restart Codex windows created before this install; they keep the provider they were started with.'
