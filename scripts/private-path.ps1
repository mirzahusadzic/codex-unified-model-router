function Set-PrivatePath([string]$Path) {
    $Item = Get-Item -LiteralPath $Path -Force
    if ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to store credentials through a reparse point: $Path"
    }
    $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $Acl = Get-Acl -LiteralPath $Path
    $Acl.SetOwner($Identity)
    $Acl.SetAccessRuleProtection($true, $false)
    foreach ($Rule in @($Acl.Access)) { [void]$Acl.RemoveAccessRuleSpecific($Rule) }
    $Inheritance = if ($Item.PSIsContainer) {
        [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else { [System.Security.AccessControl.InheritanceFlags]::None }
    $Rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $Identity, [System.Security.AccessControl.FileSystemRights]::FullControl,
        $Inheritance, [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $Acl.AddAccessRule($Rule)
    Set-Acl -LiteralPath $Path -AclObject $Acl
    Assert-PrivatePath $Path
}

function Assert-PrivatePath([string]$Path) {
    $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $Actual = Get-Acl -LiteralPath $Path
    $Rules = @($Actual.Access)
    if ($Actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $Identity.Value -or
        -not $Actual.AreAccessRulesProtected -or $Rules.Count -ne 1 -or
        $Rules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $Identity.Value -or
        $Rules[0].AccessControlType -ne 'Allow' -or $Rules[0].FileSystemRights -ne 'FullControl') {
        throw "Could not restrict access to $Path"
    }
}
