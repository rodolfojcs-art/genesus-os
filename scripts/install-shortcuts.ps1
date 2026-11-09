# Integra GENESUS OS como software instalado: Escritorio + menú Inicio + Inicio automático.
$exe = 'C:\Users\rodol\genesus-os\apps\desktop\release\win-unpacked\GENESUS OS.exe'
if (-not (Test-Path $exe)) { Write-Output "No existe el exe: $exe"; exit 1 }
$ws = New-Object -ComObject WScript.Shell

function New-Lnk($linkPath) {
  $dir = Split-Path $linkPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $sc = $ws.CreateShortcut($linkPath)
  $sc.TargetPath = $exe
  $sc.WorkingDirectory = (Split-Path $exe)
  $sc.IconLocation = $exe
  $sc.Description = 'GENESUS OS — tu IA personal'
  $sc.Save()
  Write-Output ("  creado: " + $linkPath)
}

$desktop  = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')          # Menú Inicio del usuario
$startup  = [Environment]::GetFolderPath('Startup')           # Inicio automático

New-Lnk (Join-Path $desktop  'GENESUS OS.lnk')
New-Lnk (Join-Path $programs 'GENESUS OS.lnk')
New-Lnk (Join-Path $startup  'GENESUS OS.lnk')

Write-Output 'Listo: Escritorio + Menu Inicio + Inicio automatico configurados.'
