Add-Type -AssemblyName System.Drawing
$size = 512
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# Fondo redondeado oscuro
$r = 96
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $r, $r, 180, 90)
$path.AddArc(($size - $r), 0, $r, $r, 270, 90)
$path.AddArc(($size - $r), ($size - $r), $r, $r, 0, 90)
$path.AddArc(0, ($size - $r), $r, $r, 90, 90)
$path.CloseFigure()
$bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(20, 18, 31))
$g.FillPath($bg, $path)

$scale = [double]$size / 300.0
$oy = ([double]$size - 295.0 * $scale) / 2.0

function Draw-Bar($g, $pts, $hex, $scale, $oy) {
  $col = [System.Drawing.ColorTranslator]::FromHtml($hex)
  $br = New-Object System.Drawing.SolidBrush($col)
  $arr = @()
  for ($i = 0; $i -lt $pts.Length; $i += 2) {
    $arr += New-Object System.Drawing.PointF(($pts[$i] * $scale), ($pts[$i + 1] * $scale + $oy))
  }
  $g.FillPolygon($br, [System.Drawing.PointF[]]$arr)
}

Draw-Bar $g @(67, 65, 93, 65, 46, 195, 20, 195) '#7B68FF' $scale $oy
Draw-Bar $g @(149, 50, 175, 50, 108, 235, 82, 235) '#00D4A0' $scale $oy
Draw-Bar $g @(188, 148, 214, 148, 174, 258, 148, 258) '#FFC040' $scale $oy
Draw-Bar $g @(242, 200, 268, 200, 241, 275, 215, 275) '#F06292' $scale $oy

$out = 'C:\Users\rodol\genesus-os\apps\desktop\icon.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output ("icono creado: " + $out + " (" + (Get-Item $out).Length + " bytes)")
