#Requires -Version 5.1
param([string]$OutputDirectory = (Split-Path -Parent $PSScriptRoot))

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-IconBitmap([int]$size) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $body = New-Object System.Drawing.Drawing2D.GraphicsPath
    $blue = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#0369A1'), 12)
    $green = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#059669'), 12)
    $top = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#0369A1'))
    $fill = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#F6FAFF'))
    $dot = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#059669'))
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.ScaleTransform(($size / 256.0), ($size / 256.0))
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $blue.StartCap = $blue.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $green.StartCap = $green.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $green.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $body.AddLine(40, 60, 40, 193)
        $body.AddBezier(40, 193, 40, 225, 216, 225, 216, 193)
        $body.AddLine(216, 193, 216, 60)
        $body.CloseFigure()
        $graphics.FillPath($fill, $body)
        $graphics.DrawLine($blue, 40, 60, 40, 193)
        $graphics.DrawLine($blue, 216, 60, 216, 193)
        $graphics.DrawArc($blue, 40, 168, 176, 50, 0, 180)
        $graphics.DrawArc($blue, 40, 103, 176, 50, 0, 180)
        $graphics.FillEllipse($top, 34, 29, 188, 62)
        $points = [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new(58, 210),
            [System.Drawing.PointF]::new(89, 173),
            [System.Drawing.PointF]::new(120, 192),
            [System.Drawing.PointF]::new(151, 146),
            [System.Drawing.PointF]::new(182, 165),
            [System.Drawing.PointF]::new(210, 152)
        )
        $graphics.DrawLines($green, $points)
        $graphics.FillEllipse($dot, 203, 145, 14, 14)
    } finally {
        $graphics.Dispose()
        $body.Dispose()
        $blue.Dispose()
        $green.Dispose()
        $top.Dispose()
        $fill.Dispose()
        $dot.Dispose()
    }
    return $bitmap
}

$frames = @()
foreach ($size in @(16, 20, 24, 32, 40, 48, 64, 128, 256)) {
    $bitmap = New-IconBitmap $size
    $stream = New-Object System.IO.MemoryStream
    try {
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $frames += [pscustomobject]@{ Size = $size; Bytes = $stream.ToArray() }
        if ($size -eq 256) {
            $bitmap.Save((Join-Path $OutputDirectory 'sql-dashboard-logo.png'), [System.Drawing.Imaging.ImageFormat]::Png)
        }
    } finally { $stream.Dispose(); $bitmap.Dispose() }
}

$iconFile = [System.IO.File]::Create((Join-Path $OutputDirectory 'sql-dashboard-app.ico'))
$writer = New-Object System.IO.BinaryWriter($iconFile)
try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$frames.Count)
    $offset = 6 + 16 * $frames.Count
    foreach ($frame in $frames) {
        $dimension = $frame.Size
        if ($dimension -eq 256) { $dimension = 0 }
        $writer.Write([byte]$dimension)
        $writer.Write([byte]$dimension)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$frame.Bytes.Length)
        $writer.Write([uint32]$offset)
        $offset += $frame.Bytes.Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame.Bytes) }
} finally { $writer.Dispose(); $iconFile.Dispose() }

Write-Output 'Generated blue database and green pulse icon with nine high-DPI sizes.'
