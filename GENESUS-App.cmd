@echo off
REM ============================================================
REM  GENESUS OS — App de escritorio (un solo clic)
REM  Compila la interfaz y abre GENESUS en su ventana nativa.
REM  El servidor arranca solo; al cerrar la ventana se detiene.
REM ============================================================
cd /d "%~dp0"
echo.
echo   GENESUS OS — iniciando aplicacion de escritorio...
echo   (la primera vez compila la interfaz; puede tardar un momento)
echo.
call pnpm desktop
