$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$frontendRoot = Join-Path $projectRoot 'frontend'
$backgroundSource = Join-Path $projectRoot 'BackGroudPics'
$backgroundTarget = Join-Path $frontendRoot 'BackGroudPics'

New-Item -ItemType Directory -Force -Path $frontendRoot | Out-Null
New-Item -ItemType Directory -Force -Path $backgroundTarget | Out-Null

foreach ($fileName in @('index.html', 'script.js', 'style.css', 'backgrounds.js')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $fileName) -Destination (Join-Path $frontendRoot $fileName) -Force
}

if (Test-Path -LiteralPath $backgroundSource) {
    Get-ChildItem -LiteralPath $backgroundSource -Force | Copy-Item -Destination $backgroundTarget -Recurse -Force
}

Write-Output "Frontend assets prepared: $frontendRoot"
