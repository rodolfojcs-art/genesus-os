# Crea un acceso directo a GENESUS OS en el Escritorio (como software instalado).
$exe = 'C:\Users\rodol\genesus-os\apps\desktop\release\win-unpacked\GENESUS OS.exe'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'GENESUS OS.lnk'
if (-not (Test-Path $exe)) { Write-Output "No existe el exe empaquetado: $exe"; exit 1 }
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = $exe
$sc.WorkingDirectory = (Split-Path $exe)
$sc.IconLocation = $exe
$sc.Description = 'GENESUS OS — tu IA personal'
$sc.Save()
Write-Output ("Acceso directo creado: " + $lnk)
