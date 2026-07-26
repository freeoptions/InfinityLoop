param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $projectRoot 'src-tauri\target\release'
$releaseExe = Join-Path $releaseRoot 'infinity-loop.exe'
$sourceLibRoot = Join-Path $projectRoot 'src-tauri\lib'
$deliveryRoot = 'D:\@Software\InfinityLoop'
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

$sourceLibmpv = Join-Path $sourceLibRoot 'libmpv-2.dll'
$sourceLibmpvWrapper = Join-Path $sourceLibRoot 'libmpv-wrapper.dll'

foreach ($requiredFile in @($releaseExe, $sourceLibmpv, $sourceLibmpvWrapper)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required release file not found: $requiredFile"
    }
}

$deliveryLibRoot = Join-Path $deliveryRoot 'lib'
New-Item -ItemType Directory -Force -Path $deliveryLibRoot | Out-Null

Copy-Item -LiteralPath $releaseExe -Destination (Join-Path $deliveryRoot 'InfinityLoop.exe') -Force
Copy-Item -LiteralPath $sourceLibmpv -Destination (Join-Path $deliveryLibRoot 'libmpv-2.dll') -Force
Copy-Item -LiteralPath $sourceLibmpvWrapper -Destination (Join-Path $deliveryLibRoot 'libmpv-wrapper.dll') -Force

Write-Output "Release copied to $deliveryRoot"
