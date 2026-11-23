$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $projectRoot
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $currentUser.Value) {
    throw 'Run this from the Windows account that owns the project.'
}

# Replace inherited access on this checkout and propagate its private defaults.
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
foreach ($sid in @($currentUser.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $projectRoot -AclObject $acl
Write-Output 'Project access restricted to the project owner, SYSTEM and administrators.'
