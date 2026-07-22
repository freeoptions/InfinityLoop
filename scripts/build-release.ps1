param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $projectRoot 'src-tauri\target\release'
$releaseExe = Join-Path $releaseRoot 'infinity-loop.exe'
$deliveryRoot = 'D:\@Software\InfinityLoop'
$deliveryMpvRoot = Join-Path $deliveryRoot 'resources\mpv'
$tauriCli = Join-Path $projectRoot 'node_modules\.bin\tauri.cmd'

if (-not $SkipBuild) {
    if (-not (Test-Path -LiteralPath $tauriCli -PathType Leaf)) {
        throw "Tauri CLI not found: $tauriCli"
    }

    Push-Location $projectRoot
    try {
        & $tauriCli build --no-bundle --ci
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    }
    finally {
        Pop-Location
    }
}

$releaseMpv = Join-Path $releaseRoot 'resources\mpv\mpv.exe'
$releaseInputConfig = Join-Path $releaseRoot 'resources\mpv\portable_config\input.conf'

foreach ($requiredFile in @($releaseExe, $releaseMpv, $releaseInputConfig)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required release file not found: $requiredFile"
    }
}

$deliveryInputConfig = Join-Path $deliveryMpvRoot 'portable_config'
New-Item -ItemType Directory -Force -Path $deliveryInputConfig | Out-Null

Copy-Item -LiteralPath $releaseExe -Destination (Join-Path $deliveryRoot 'InfinityLoop.exe') -Force
Copy-Item -LiteralPath $releaseMpv -Destination (Join-Path $deliveryMpvRoot 'mpv.exe') -Force
Copy-Item -LiteralPath $releaseInputConfig -Destination (Join-Path $deliveryInputConfig 'input.conf') -Force

Write-Output "Release copied to $deliveryRoot"
