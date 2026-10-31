# Dot-sourced by install.ps1 and verify-install.ps1.
#
# The router answering health must be the service's own: a process the
# supervisor (the cmd.exe running start-router.cmd) started, directly or through
# a version manager's shim. A stray copy of the router holding the port is not.

# Returns the supervisors' descendants, comma-separated, or an empty string
# when no supervisor runs.
function Get-RouterServicePids {
    param([Parameter(Mandatory = $true)][string]$StartCmd)

    $Processes = @(Get-CimInstance Win32_Process)
    $Pending = New-Object System.Collections.Generic.Queue[int]
    foreach ($Process in $Processes) {
        if ($Process.Name -eq 'cmd.exe' -and $Process.CommandLine -and
            $Process.CommandLine.IndexOf($StartCmd, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $Pending.Enqueue([int]$Process.ProcessId)
        }
    }
    $Found = New-Object System.Collections.Generic.List[int]
    while ($Pending.Count -gt 0) {
        $Parent = $Pending.Dequeue()
        foreach ($Process in $Processes) {
            $Child = [int]$Process.ProcessId
            if ([int]$Process.ParentProcessId -eq $Parent -and $Child -ne $Parent -and -not $Found.Contains($Child)) {
                $Found.Add($Child)
                $Pending.Enqueue($Child)
            }
        }
    }
    return ($Found -join ',')
}
