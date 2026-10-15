#Requires -Version 5.1
param([string]$OutputDirectory = (Split-Path -Parent $PSScriptRoot))

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-RoundedPath([single]$x, [single]$y, [single]$width, [single]$height, [single]$radius) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $diameter = $radius * 2
    $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
    $path.AddArc(($x + $width - $diameter), $y, $diameter, $diameter, 270, 90)
    $path.AddArc(($x + $width - $diameter), ($y + $height - $diameter), $diameter, $diameter, 0, 90)
    $path.AddArc($x, ($y + $height - $diameter), $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-IconBitmap([int]$size) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $tile = New-RoundedPath 8 8 240 240 48
    $background = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#252A32'))
    $edge = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#46505F'), 2)
    $rose = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#F38BA4'), 11)
    $ivory = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#FCFBF8'), 11)
    $highlight = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#FCFBF8'))
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.ScaleTransform(($size / 256.0), ($size / 256.0))
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.FillPath($background, $tile)
        $graphics.DrawPath($edge, $tile)
        $rose.StartCap = $rose.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $ivory.StartCap = $ivory.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $ivory.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        # A simple database silhouette and telemetry trace stay legible at desktop sizes.
        $graphics.DrawEllipse($rose, 57, 50, 142, 40)
        $graphics.DrawLine($rose, 57, 70, 57, 174)
        $graphics.DrawLine($rose, 199, 70, 199, 132)
        $graphics.DrawArc($rose, 57, 102, 142, 40, 0, 180)
        $graphics.DrawArc($rose, 57, 154, 142, 40, 0, 180)
        $points = [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new(53, 190),
            [System.Drawing.PointF]::new(84, 162),
            [System.Drawing.PointF]::new(111, 175),
            [System.Drawing.PointF]::new(144, 128),
            [System.Drawing.PointF]::new(167, 149),
            [System.Drawing.PointF]::new(203, 115)
        )
        $graphics.DrawLines($ivory, $points)
        $graphics.FillEllipse($highlight, 195, 107, 16, 16)
    } finally {
        $graphics.Dispose()
        $tile.Dispose()
        $background.Dispose()
        $edge.Dispose()
        $rose.Dispose()
        $ivory.Dispose()
        $highlight.Dispose()
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

Write-Output 'Generated SQL Pulse icon with nine high-DPI sizes.'
