$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$iconDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri\icons'
New-Item -ItemType Directory -Force -Path $iconDirectory | Out-Null

$size = 256
$bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.Clear([System.Drawing.Color]::FromArgb(11, 16, 32))

$cardPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$cardPath.AddRectangle([System.Drawing.RectangleF]::new(16, 16, 224, 224))
$cardBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    [System.Drawing.RectangleF]::new(16, 16, 240, 240),
    [System.Drawing.Color]::FromArgb(28, 40, 78),
    [System.Drawing.Color]::FromArgb(16, 24, 48),
    135
)
$graphics.FillPath($cardBrush, $cardPath)

$shadowPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(85, 110, 170), 30)
$shadowPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$shadowPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$loopPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$loopPath.AddBezier(128, 128, 93, 76, 58, 76, 58, 128)
$loopPath.AddBezier(58, 128, 58, 180, 93, 180, 128, 128)
$loopPath.AddBezier(128, 128, 163, 76, 198, 76, 198, 128)
$loopPath.AddBezier(198, 128, 198, 180, 163, 180, 128, 128)
$graphics.DrawPath($shadowPen, $loopPath)

$loopPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(245, 248, 255), 22)
$loopPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$loopPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawPath($loopPen, $loopPath)

$accentBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(106, 146, 255))
$graphics.FillEllipse($accentBrush, 185, 48, 16, 16)

$pngPath = Join-Path ([System.IO.Path]::GetTempPath()) ('InfinityLoop-icon-' + [guid]::NewGuid().ToString('N') + '.png')
$icoPath = Join-Path $iconDirectory 'icon.ico'
$bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$graphics.Dispose()
$cardBrush.Dispose()
$cardPath.Dispose()
$shadowPen.Dispose()
$loopPen.Dispose()
$loopPath.Dispose()
$accentBrush.Dispose()
$bitmap.Dispose()

$pngBytes = [System.IO.File]::ReadAllBytes($pngPath)
$stream = New-Object System.IO.FileStream($icoPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$writer = New-Object System.IO.BinaryWriter($stream)
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]1)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([uint16]1)
$writer.Write([uint16]32)
$writer.Write([uint32]$pngBytes.Length)
$writer.Write([uint32]22)
$writer.Write($pngBytes)
$writer.Flush()
$writer.Dispose()
$stream.Dispose()

Remove-Item -LiteralPath $pngPath -Force
Write-Output "InfinityLoop icon created: $icoPath"
