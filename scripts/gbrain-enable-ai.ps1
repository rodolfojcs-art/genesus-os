# =====================================================================
#  GBrain — habilitar IA completa (embeddings locales con Ollama)
#  Uso:  powershell -ExecutionPolicy Bypass -File scripts\gbrain-enable-ai.ps1
#
#  REQUISITOS: Ollama corriendo + modelo nomic-embed-text.
#  El script arranca Ollama si está apagado.
#
#  POR QUÉ ESTE SCRIPT CAMBIÓ (2026-11-09): la versión anterior llamaba
#  directo a `init --force`, y eso tenía DOS fallas graves:
#    1. No respaldaba nada. `init --force` + cambio de dimensiones DESTRUYE
#       todas las páginas del cerebro. 99 páginas se habrían perdido.
#    2. No funcionaba. Si el config tenía el sentinel `embedding_disabled:true`
#       (que deja `init --no-embedding`), init.ts lo honra ANTES de leer las
#       banderas de la línea de comandos, descarta --embedding-model y vuelve a
#       escribir el sentinel. El script corría "bien" y dejaba todo igual.
#  Ahora: respalda -> quita el sentinel -> reinit-pglite -> reimporta -> embebe.
# =====================================================================
$ErrorActionPreference = 'Stop'
$env:PATH = "$env:USERPROFILE\.bun\bin;" + $env:PATH

$gbrain   = 'C:\Users\rodol\gbrain\gbrain-master'
$cfgPath  = "$env:USERPROFILE\.gbrain\config.json"
$stamp    = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup   = "C:\Users\rodol\gbrain-backup-$stamp"
$model    = 'ollama:nomic-embed-text'
$dims     = 768   # nomic-embed-text es 768d. Si cambias de modelo, ajusta esto.

# Llave solo para la síntesis con IA (think/expansion). Los embeddings son locales.
$envFile = 'C:\Users\rodol\genesus-os\apps\server\.env'
$m = Select-String -Path $envFile -Pattern '^ANTHROPIC_API_KEY=(.+)$'
if ($m) { $env:ANTHROPIC_API_KEY = $m.Matches.Groups[1].Value }

Write-Host '== 0. Ollama ==' -ForegroundColor Cyan
try {
  $tags = Invoke-RestMethod -Uri 'http://localhost:11434/api/tags' -TimeoutSec 5
  Write-Host '   Ollama ya está corriendo.'
} catch {
  Write-Host '   Ollama apagado: arrancándolo...'
  Start-Process -FilePath "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" -ArgumentList 'serve' -WindowStyle Hidden
  Start-Sleep -Seconds 10
  $tags = Invoke-RestMethod -Uri 'http://localhost:11434/api/tags' -TimeoutSec 10
}
if (-not ($tags.models.name -match 'nomic-embed-text')) {
  Write-Host '   Falta nomic-embed-text. Descargando...'
  & "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" pull nomic-embed-text
}
Write-Host '   Modelo de embeddings disponible.' -ForegroundColor Green

Set-Location $gbrain

Write-Host "== 1. RESPALDO -> $backup ==" -ForegroundColor Cyan
# Markdown de todas las páginas (esto es lo que se reimporta después).
bun run src/cli.ts export --dir $backup
# Y la base entera, por si hay que volver atrás del todo.
New-Item -ItemType Directory -Force -Path "$backup-db" | Out-Null
Copy-Item "$env:USERPROFILE\.gbrain\brain.pglite" "$backup-db\" -Recurse -Force
Copy-Item $cfgPath "$backup-db\" -Force
$paginas = (Get-ChildItem -Path $backup -Filter *.md -Recurse).Count
Write-Host "   $paginas paginas respaldadas en markdown + base completa en $backup-db" -ForegroundColor Green
if ($paginas -eq 0) { Write-Host '   ABORTO: el respaldo salio vacio.' -ForegroundColor Red; exit 1 }

Write-Host '== 2. Quitando el sentinel embedding_disabled ==' -ForegroundColor Cyan
# Sin esto, init/reinit ignoran --embedding-model en silencio (ver cabecera).
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
if ($cfg.PSObject.Properties.Name -contains 'embedding_disabled') {
  $cfg.PSObject.Properties.Remove('embedding_disabled')
  $cfg | ConvertTo-Json -Depth 10 | Set-Content $cfgPath -Encoding utf8
  Write-Host '   Sentinel eliminado.' -ForegroundColor Green
} else {
  Write-Host '   No estaba puesto.'
}

Write-Host "== 3. Re-templando el esquema a $dims dimensiones ==" -ForegroundColor Cyan
# reinit-pglite es el comando que GBrain exige para cambiar de ancho de vector.
# `init --force` se NIEGA a hacerlo ("Refusing to silently re-template").
# Deja el cerebro VACIO: por eso el paso 4 reimporta.
bun run src/cli.ts reinit-pglite --embedding-model $model --embedding-dimensions $dims --yes

Write-Host '== 4. Reimportando las paginas respaldadas ==' -ForegroundColor Cyan
bun run src/cli.ts import $backup --no-embed

Write-Host '== 5. Generando embeddings locales (Ollama, $0) ==' -ForegroundColor Cyan
bun run src/cli.ts embed --all

Write-Host '== 6. Verificacion ==' -ForegroundColor Cyan
bun run src/cli.ts doctor 2>&1 | Select-String -Pattern 'embeddings:|embedding_provider:'

Write-Host ''
Write-Host 'Listo si arriba dice "100% coverage" y el proveedor alineado.' -ForegroundColor Green
Write-Host "Respaldo conservado en: $backup  (y la base en $backup-db)"
Write-Host 'OJO: Ollama debe estar corriendo para embeber capturas NUEVAS.'
