param([Parameter(Mandatory = $true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
& $NodePath (Join-Path $projectRoot 'src\scheduler-cli.js') --managed
exit $LASTEXITCODE
