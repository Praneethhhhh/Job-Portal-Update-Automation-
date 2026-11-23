$ErrorActionPreference = 'Stop'
try {
    $task = Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq 'NaukriProfileScheduler' -and $_.TaskPath -eq '\' } | Select-Object -First 1
    if ($null -eq $task) { @{ state = 'not-installed'; running = $false } | ConvertTo-Json -Compress }
    else {
        $projectRoot = Split-Path -Parent $PSScriptRoot
        if ($task.Actions.WorkingDirectory -notcontains $projectRoot) { throw 'Task belongs to a different checkout.' }
        $state = if ($task.State -eq 'Disabled') { 'paused' } else { 'enabled' }
        @{ state = $state; running = ($task.State -eq 'Running') } | ConvertTo-Json -Compress
    }
} catch { @{ state = 'unknown'; running = $false } | ConvertTo-Json -Compress }
