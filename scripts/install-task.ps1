param([switch]$Remove, [switch]$Pause, [switch]$Resume, [switch]$Preview, [switch]$SessionOnly)
$ErrorActionPreference = 'Stop'
if (([int]$Remove.IsPresent + [int]$Pause.IsPresent + [int]$Resume.IsPresent + [int]$Preview.IsPresent + [int]$SessionOnly.IsPresent) -gt 1) { throw 'Choose one action.' }
$projectRoot = Split-Path -Parent $PSScriptRoot
$taskName = 'NaukriProfileScheduler'
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
if ($Remove) {
    $task = $folder.GetTask($taskName)
    $task.Enabled = $false
    $folder.DeleteTask($taskName, 0)
    $marker = $folder.GetTasks(0) | Where-Object Name -eq "$taskName-Session"
    if ($marker) { $folder.DeleteTask("$taskName-Session", 0) }
    Write-Output 'Schedule removed. An active reserved attempt may finish; the worker then exits.'
    exit
}
if ($Pause) {
    $task = $folder.GetTask($taskName)
    $task.Enabled = $false
    Write-Output 'Schedule paused. An active reserved attempt may finish; the worker then exits.'
    exit
}
$nodePath = (Get-Command node.exe).Source
if (-not $Preview) {
    & (Join-Path $PSScriptRoot 'assert-task-access.ps1') -ProjectRoot $projectRoot -NodePath $nodePath
}
if (-not $Preview -and -not $SessionOnly) {
    & $nodePath (Join-Path $projectRoot 'src\check-automation-cli.js')
    if ($LASTEXITCODE -ne 0) { throw 'Check local configuration and site permission before installing.' }
}
if ($Resume) {
    $task = $folder.GetTask($taskName)
    $task.Enabled = $true
    $null = $task.Run($null)
    Write-Output 'Schedule resumed. The activation flag and existing budget still apply.'
    exit
}
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$definition = $service.NewTask(0)
$definition.RegistrationInfo.Description = 'Local profile runner at sign-in and resume. The dashboard switch controls hourly profile updates.'
$definition.Principal.UserId = $sid
$definition.Principal.LogonType = 3 # InteractiveToken; never run before sign-in.
$definition.Principal.RunLevel = 0 # Least privilege.
$settings = $definition.Settings
$settings.Enabled = $true
$settings.MultipleInstances = 2 # IgnoreNew.
$settings.ExecutionTimeLimit = 'PT0S' # Do not kill restoration at a time limit.
$settings.DisallowStartIfOnBatteries = $false
$settings.StopIfGoingOnBatteries = $false
$settings.StartWhenAvailable = $false
$settings.WakeToRun = $false
$settings.RestartCount = 0
$logon = $definition.Triggers.Create(9)
$logon.UserId = $sid
$logon.Enabled = $true
$unlock = $definition.Triggers.Create(11)
$unlock.UserId = $sid
$unlock.StateChange = 8 # Session unlock.
$unlock.Enabled = $true
$resumeTrigger = $definition.Triggers.Create(0)
$resumeTrigger.Subscription = "<QueryList><Query Id='0' Path='System'><Select Path='System'>*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1]]</Select></Query></QueryList>"
$resumeTrigger.Enabled = $true
# A watchdog repairs an orderly worker exit/resume race. It never replays missed
# profile cycles; the worker's persisted budget still decides every attempt.
$watchdog = $definition.Triggers.Create(1)
$watchdog.StartBoundary = (Get-Date).AddMinutes(5).ToString('yyyy-MM-ddTHH:mm:ss')
$watchdog.Repetition.Interval = 'PT5M'
$watchdog.Enabled = $true
$action = $definition.Actions.Create(0)
$action.Path = Join-Path $env:SystemRoot 'System32\wscript.exe'
$launcher = Join-Path $projectRoot 'scripts\run-scheduler-hidden.vbs'
$worker = Join-Path $projectRoot 'src\scheduler-cli.js'
$action.Arguments = '//B //NoLogo "' + $launcher + '" "' + $nodePath + '" "' + $worker + '"'
$action.WorkingDirectory = $projectRoot
if ($Preview) { Write-Output $definition.XmlText; exit }
if (-not $SessionOnly) {
    $task = $folder.RegisterTaskDefinition($taskName, $definition, 6, $sid, $null, 3, $null)
}
$definition.Triggers.Remove(4) # The backup timer must never reset the hourly window.
$definition.Triggers.Remove(2) # Unlock alone is not a new sign-in or wake.
$definition.Settings.ExecutionTimeLimit = 'PT1M'
$definition.RegistrationInfo.Description = 'Records Windows sign-in or wake for the profile scheduler.'
$sessionWorker = Join-Path $projectRoot 'src\windows-session-cli.js'
$definition.Actions.Item(1).Arguments = '//B //NoLogo "' + $launcher + '" "' + $nodePath + '" "' + $sessionWorker + '"'
$null = $folder.RegisterTaskDefinition("$taskName-Session", $definition, 6, $sid, $null, 3, $null)
if ($SessionOnly) {
    $marker = $folder.GetTask("$taskName-Session")
    $types = @($marker.Definition.Triggers | ForEach-Object { [int]$_.Type } | Sort-Object)
    if (!$marker.Enabled -or ($types -join ',') -ne '0,9' -or $marker.Definition.Actions.Item(1).Arguments -notlike '*windows-session-cli.js*') {
        throw 'Installed session task did not match the expected configuration.'
    }
    Write-Output 'Session task installed and verified: enabled, sign-in and wake triggers, local marker action.'
    exit
}
$null = $task.Run($null)
Write-Output 'Schedule installed and worker started. Workflow On/Off and the durable budget control all attempts.'
