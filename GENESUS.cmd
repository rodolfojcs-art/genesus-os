@echo off
REM ============================================================
REM  GENESUS OS — lanzador unico de tu IA personal
REM  Doble clic para levantar todo: servidor + web + Open WebUI
REM ============================================================
cd /d "%~dp0"

echo.
echo  GENESUS OS — iniciando tu IA personal...
echo.

REM 1) Open WebUI (si Docker esta corriendo)
where docker >nul 2>nul
if %ERRORLEVEL%==0 (
  echo  [1/2] Levantando Open WebUI en http://localhost:3000 ...
  docker compose -f openwebui\docker-compose.yml up -d
) else (
  echo  [1/2] Docker no detectado: omito Open WebUI ^(abre Docker Desktop y reintenta^).
)

REM 2) Servidor + Web (server :8787, web :5173)
echo  [2/2] Levantando GENESUS (server :8787 + web :5173) ...
echo.
echo  Abre:  http://localhost:5173   (app GENESUS, pestanas: GENESUS Personal y Boveda)
echo         http://localhost:3000   (Open WebUI, modelo genesus-personal)
echo.
call pnpm dev
