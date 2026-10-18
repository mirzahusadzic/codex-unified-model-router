$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\private-path.ps1')
$TestDir = Join-Path ([System.IO.Path]::GetTempPath()) ('router-acl-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TestDir | Out-Null
try {
    $KeyFile = Join-Path $TestDir 'openrouter.env'
    [System.IO.File]::WriteAllText($KeyFile, 'synthetic key only')
    $Everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    foreach ($Path in @($TestDir, $KeyFile)) {
        $Acl = Get-Acl -LiteralPath $Path
        $Acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            $Everyone, [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.AccessControlType]::Allow
        ))
        Set-Acl -LiteralPath $Path -AclObject $Acl
        $Rejected = $false
        try { Assert-PrivatePath $Path } catch { $Rejected = $true }
        if (-not $Rejected) { throw 'Verifier accepted a publicly accessible credential path.' }
        Set-PrivatePath $Path
        Assert-PrivatePath $Path
        Set-PrivatePath $Path
        Assert-PrivatePath $Path
    }
    if ([System.IO.File]::ReadAllText($KeyFile) -ne 'synthetic key only') {
        throw 'Restricting reused credentials changed their contents.'
    }
    Write-Host 'Private directory and reused-file ACL checks passed.'
} finally {
    Remove-Item -LiteralPath $TestDir -Recurse -Force
}
