# =====================================================================
#  Iconos de la PWA (GENESUS OS) — generados desde el LOGO OFICIAL.
#
#  FUENTE UNICA: packages/ui/src/Logo.tsx, que lleva la spec definitiva y
#  dice literalmente "NUNCA modificar las coordenadas". Este script copia
#  esos mismos poligonos y colores; no se inventa nada.
#
#      viewBox 0 0 300 295
#      67,65  93,65  46,195 20,195   #7B68FF
#      149,50 175,50 108,235 82,235  #00D4A0
#      188,148 214,148 174,258 148,258  #FFC040
#      242,200 268,200 241,275 215,275  #F06292
#
#  Si algun dia cambia Logo.tsx, hay que volver a correr esto.
#
#  Uso:  powershell -ExecutionPolicy Bypass -File scripts\make-pwa-icons.ps1
# =====================================================================
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# Poligonos del logo oficial, en su espacio original de 300x295.
$BARRAS = @(
  @{ pts = @(67,65, 93,65, 46,195, 20,195);        hex = '#7B68FF' },
  @{ pts = @(149,50, 175,50, 108,235, 82,235);     hex = '#00D4A0' },
  @{ pts = @(188,148, 214,148, 174,258, 148,258);  hex = '#FFC040' },
  @{ pts = @(242,200, 268,200, 241,275, 215,275);  hex = '#F06292' }
)
$FONDO = [System.Drawing.Color]::FromArgb(20, 18, 31)

function New-IconoGenesus([int]$S, [string]$Out, [double]$Ocupacion) {
  $bmp = New-Object System.Drawing.Bitmap($S, $S)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

  # Fondo a sangre completa: Android recorta el icono con su propia mascara
  # (circulo, squircle...), asi que el color debe llegar a los bordes. El
  # margen lo da $Ocupacion, dejando el logo dentro de la zona segura.
  $g.Clear($FONDO)

  # El logo mide 300x295; se escala para ocupar $Ocupacion del lienzo y se centra.
  $escala = ($S * $Ocupacion) / 300.0
  $anchoLogo = 300.0 * $escala
  $altoLogo  = 295.0 * $escala
  $tx = ($S - $anchoLogo) / 2.0
  $ty = ($S - $altoLogo) / 2.0

  foreach ($b in $BARRAS) {
    $col = [System.Drawing.ColorTranslator]::FromHtml($b.hex)
    $br  = New-Object System.Drawing.SolidBrush($col)
    $pts = @()
    for ($i = 0; $i -lt $b.pts.Length; $i += 2) {
      $pts += New-Object System.Drawing.PointF(
        ([float]($b.pts[$i]     * $escala + $tx)),
        ([float]($b.pts[$i + 1] * $escala + $ty))
      )
    }
    $g.FillPolygon($br, [System.Drawing.PointF[]]$pts)
    $br.Dispose()
  }

  $g.Dispose()
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  '  ' + (Split-Path $Out -Leaf) + '  ' + [math]::Round((Get-Item $Out).Length / 1KB, 1) + ' KB'
}

$pub = 'C:\Users\rodol\genesus-os\apps\web\public'
# 0.62 deja el margen que pide la zona segura de los iconos "maskable":
# Android puede recortar hasta un 10% por lado y el logo no debe tocarse.
New-IconoGenesus 192 "$pub\icon-192.png" 0.62
New-IconoGenesus 512 "$pub\icon-512.png" 0.62
Write-Output 'Iconos de la PWA regenerados desde packages/ui/src/Logo.tsx'
