param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][string]$NodePath
)
$ErrorActionPreference = 'Stop'
$sidType = [System.Security.Principal.SecurityIdentifier]
$allowed = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
$writeRights = [System.Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
$privateRights = $writeRights -bor [System.Security.AccessControl.FileSystemRights]::ReadData
# Chromium grants its network sandbox this capability on these profile directories.
$networkCapability = 'S-1-15-3-1024-1653277547-598600573-1504598449-2187120098-1115546814-1860042162-2924348907-3700367812'
$networkDirectories = foreach ($channel in @('chrome', 'msedge')) {
    foreach ($name in @('Cache', 'Network', 'Safe Browsing Network', 'Shared Dictionary')) {
        Join-Path $ProjectRoot ".local\browser\$channel\Default\$name"
    }
}

function Assert-PathAccess($target, $rights) {
    $acl = Get-Acl -LiteralPath $target
    if ($acl.GetOwner($sidType).Value -notin $allowed) { throw "Untrusted Windows owner on $target." }
    foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {
        if ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
        if ($rule.IdentityReference.Value -eq $networkCapability -and
            ($networkDirectories | Where-Object {
                $target -eq $_ -or $target.StartsWith($_ + '\', [System.StringComparison]::OrdinalIgnoreCase)
            })) { continue }
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed -and ($rule.FileSystemRights -band $rights)) {
            throw "Untrusted Windows access on $target."
        }
    }
}

if (!(Get-Acl -LiteralPath $ProjectRoot).AreAccessRulesProtected) {
    throw 'Protect this checkout first with scripts\protect-project.ps1.'
}
Assert-PathAccess $ProjectRoot $writeRights
Assert-PathAccess $NodePath $writeRights
Assert-PathAccess (Join-Path $ProjectRoot 'package.json') $writeRights
foreach ($name in @('config.local.json', 'src', 'scripts', 'node_modules', '.local')) {
    $target = Join-Path $ProjectRoot $name
    if (!(Test-Path -LiteralPath $target)) { continue }
    $rights = if ($name -in @('config.local.json', '.local')) { $privateRights } else { $writeRights }
    $entries = [System.Collections.Generic.Stack[System.IO.FileSystemInfo]]::new()
    $entries.Push((Get-Item -LiteralPath $target -Force))
    while ($entries.Count) {
        $entry = $entries.Pop()
        if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw "Unexpected link or junction under the scheduled checkout: $($entry.FullName)."
        }
        Assert-PathAccess $entry.FullName $rights
        if ($entry.PSIsContainer) {
            foreach ($child in Get-ChildItem -LiteralPath $entry.FullName -Force) { $entries.Push($child) }
        }
    }
}
