param(
    [string]$SourcePath = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$iconDirectory = Join-Path $projectRoot 'src-tauri\icons'
$pngPath = Join-Path $projectRoot 'app-icon.png'
$icoPath = Join-Path $iconDirectory 'icon.ico'

if ([string]::IsNullOrWhiteSpace($SourcePath)) {
    $sourceMatches = @(
        Get-ChildItem -LiteralPath 'D:\@Software' -Recurse -File -Filter 'Artemis-symbol-ultra-4096.png' |
            Where-Object { $_.FullName -like '*\Upscaled-4096\*' }
    )
    if ($sourceMatches.Count -ne 1) {
        throw "Expected exactly one Artemis icon source under D:\@Software, found $($sourceMatches.Count). Pass -SourcePath explicitly."
    }
    $SourcePath = $sourceMatches[0].FullName
}

if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
    throw "Icon source not found: $SourcePath"
}

New-Item -ItemType Directory -Force -Path $iconDirectory | Out-Null

function New-ResizedIconBitmap {
    param(
        [System.Drawing.Bitmap]$Source,
        [System.Drawing.Rectangle]$SourceRectangle,
        [int]$Size
    )

    $output = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($output)
    try {
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $destination = [System.Drawing.Rectangle]::new(0, 0, $Size, $Size)
        $graphics.DrawImage($Source, $destination, $SourceRectangle, [System.Drawing.GraphicsUnit]::Pixel)
    }
    finally {
        $graphics.Dispose()
    }

    return $output
}

function Get-VisibleBounds {
    param(
        [System.Drawing.Bitmap]$Bitmap,
        [byte]$AlphaThreshold = 8
    )

    $rectangle = [System.Drawing.Rectangle]::new(0, 0, $Bitmap.Width, $Bitmap.Height)
    $data = $Bitmap.LockBits(
        $rectangle,
        [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )

    try {
        $stride = [Math]::Abs($data.Stride)
        $bytes = New-Object byte[] ($stride * $Bitmap.Height)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)

        $minX = $Bitmap.Width
        $minY = $Bitmap.Height
        $maxX = -1
        $maxY = -1

        for ($y = 0; $y -lt $Bitmap.Height; $y++) {
            $rowOffset = $y * $stride
            for ($x = 0; $x -lt $Bitmap.Width; $x++) {
                if ($bytes[$rowOffset + ($x * 4) + 3] -gt $AlphaThreshold) {
                    if ($x -lt $minX) { $minX = $x }
                    if ($x -gt $maxX) { $maxX = $x }
                    if ($y -lt $minY) { $minY = $y }
                    if ($y -gt $maxY) { $maxY = $y }
                }
            }
        }

        if ($maxX -lt 0 -or $maxY -lt 0) {
            throw "The icon source has no pixels above alpha threshold $AlphaThreshold."
        }

        return [System.Drawing.Rectangle]::FromLTRB($minX, $minY, $maxX + 1, $maxY + 1)
    }
    finally {
        $Bitmap.UnlockBits($data)
    }
}

function Get-SquareCrop {
    param(
        [System.Drawing.Rectangle]$Bounds,
        [int]$ImageWidth,
        [int]$ImageHeight,
        [int]$Padding
    )

    $side = [Math]::Max($Bounds.Width, $Bounds.Height) + ($Padding * 2)
    $side = [Math]::Min($side, [Math]::Min($ImageWidth, $ImageHeight))
    $centerX = $Bounds.Left + ($Bounds.Width / 2.0)
    $centerY = $Bounds.Top + ($Bounds.Height / 2.0)
    $left = [int][Math]::Round($centerX - ($side / 2.0))
    $top = [int][Math]::Round($centerY - ($side / 2.0))
    $left = [Math]::Max(0, [Math]::Min($left, $ImageWidth - $side))
    $top = [Math]::Max(0, [Math]::Min($top, $ImageHeight - $side))
    return [System.Drawing.Rectangle]::new($left, $top, $side, $side)
}

$source = New-Object System.Drawing.Bitmap($SourcePath)
try {
    $visibleBounds = Get-VisibleBounds -Bitmap $source -AlphaThreshold 8
    $padding = [int][Math]::Round([Math]::Max($source.Width, $source.Height) * 0.02)
    $crop = Get-SquareCrop -Bounds $visibleBounds -ImageWidth $source.Width -ImageHeight $source.Height -Padding $padding
    $compactBounds = Get-VisibleBounds -Bitmap $source -AlphaThreshold 32
    $compactPadding = [int][Math]::Round([Math]::Max($source.Width, $source.Height) * 0.03)
    $compactCrop = Get-SquareCrop -Bounds $compactBounds -ImageWidth $source.Width -ImageHeight $source.Height -Padding $compactPadding

    $master = New-ResizedIconBitmap -Source $source -SourceRectangle $crop -Size 1024
    try {
        $master.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

        $sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
        $frames = @()
        foreach ($size in $sizes) {
            if ($size -le 48) {
                $frameBitmap = New-ResizedIconBitmap -Source $source -SourceRectangle $compactCrop -Size $size
            }
            else {
                $frameBitmap = New-ResizedIconBitmap -Source $master -SourceRectangle ([System.Drawing.Rectangle]::new(0, 0, 1024, 1024)) -Size $size
            }
            try {
                $memory = New-Object System.IO.MemoryStream
                $frameBitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
                $frames += ,@($size, $memory.ToArray())
                $memory.Dispose()
            }
            finally {
                $frameBitmap.Dispose()
            }
        }

        $stream = New-Object System.IO.FileStream($icoPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
        $writer = New-Object System.IO.BinaryWriter($stream)
        try {
            $writer.Write([uint16]0)
            $writer.Write([uint16]1)
            $writer.Write([uint16]$frames.Count)

            $offset = 6 + (16 * $frames.Count)
            foreach ($frame in $frames) {
                $size = [int]$frame[0]
                $bytes = [byte[]]$frame[1]
                $dimension = if ($size -eq 256) { [byte]0 } else { [byte]$size }
                $writer.Write($dimension)
                $writer.Write($dimension)
                $writer.Write([byte]0)
                $writer.Write([byte]0)
                $writer.Write([uint16]1)
                $writer.Write([uint16]32)
                $writer.Write([uint32]$bytes.Length)
                $writer.Write([uint32]$offset)
                $offset += $bytes.Length
            }

            foreach ($frame in $frames) {
                $writer.Write([byte[]]$frame[1])
            }
        }
        finally {
            $writer.Dispose()
            $stream.Dispose()
        }
    }
    finally {
        $master.Dispose()
    }
}
finally {
    $source.Dispose()
}

Write-Output "Icon source: $SourcePath"
Write-Output "Optical crop: $($crop.X),$($crop.Y) $($crop.Width)x$($crop.Height)"
Write-Output "Small-size crop: $($compactCrop.X),$($compactCrop.Y) $($compactCrop.Width)x$($compactCrop.Height)"
Write-Output "PNG created: $pngPath"
Write-Output "ICO created: $icoPath ($($sizes -join ', ')px)"
