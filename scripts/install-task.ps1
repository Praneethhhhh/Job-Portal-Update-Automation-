param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$taskName = 'NaukriProfileScheduler'
if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    exit
}
$config = Get-Content -LiteralPath (Join-Path $projectRoot 'config.local.json') -Raw | ConvertFrom-Json
if (-not $config.enabled -or -not $config.permissionConfirmed) { throw 'Enable saving and confirm permission in config.local.json before installing.' }
$nodePath = (Get-Command node.exe).Source
$cliPath = Join-Path $projectRoot 'src\cli.js'
$action = New-ScheduledTaskAction -Execute $nodePath -Argument ('"' + $cliPath + '" save') -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Hourly unchanged profile save while signed in and awake; no wake or catch-up.' -Force
