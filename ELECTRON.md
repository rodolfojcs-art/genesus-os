# ELECTRON.md — GENESUS OS como software independiente

## Estado: FASE A implementada ✅ (app de escritorio nativa)

GENESUS corre como **aplicación de escritorio**: un icono abre su propia ventana,
el servidor arranca solo y se detiene al cerrar. Sin terminal, sin navegador.

### Arquitectura

```
apps/desktop/main.cjs   ← proceso principal Electron
   │ 1. arranca el servidor (UI + API en :8787)
   │ 2. espera /api/health, muestra splash
   │ 3. abre la ventana en http://127.0.0.1:8787
   │ 4. al cerrar, detiene el servidor (taskkill /t)
apps/server  ← Fastify sirve API + la UI compilada (apps/web/dist) vía static.ts
apps/web     ← React build servido por el propio servidor (un solo puerto)
```

Un solo proceso de servidor sirve **UI + API juntas** (`apps/server/src/static.ts`,
`setNotFoundHandler` con fallback SPA), por eso Electron carga una sola URL.

### Cómo ejecutarla (desarrollo / uso local)

```
pnpm desktop        # compila la UI y abre la app de escritorio
```
O doble clic a **`GENESUS-App.cmd`** en la raíz.

Requisitos en esta máquina: Node 20+ y pnpm (ya instalados). En modo dev el
servidor se ejecuta con `tsx` desde el código fuente.

### Nota de instalación de Electron (Windows)

El binario de Electron a veces no se extrae al instalar con pnpm (queda `dist/`
sin `electron.exe` ni `path.txt`). Solución aplicada: extraer el zip de la caché
`%LOCALAPPDATA%\electron\Cache\<hash>\electron-v33.*-win32-x64.zip` dentro de
`node_modules/.pnpm/electron@*/node_modules/electron/dist` y crear `path.txt`
con el contenido `electron.exe`. (Hecho una vez; ya quedó funcional.)

## FASE B: instalador .exe distribuible (siguiente paso)

Para un ejecutable que no dependa del repo ni de Node del sistema:

```
pnpm desktop:bundle   # compila UI + bundlea el server a apps/server/dist-bundle/server.cjs (esbuild)
pnpm desktop:dist     # genera el instalador NSIS (GENESUS-OS-Setup-x.y.z.exe)
```

- `scripts/bundle-server.mjs` empaqueta el servidor en un único `server.cjs`
  (esbuild, `pg-boss` marcado external por ser opcional).
- `main.cjs` en modo empaquetado ejecuta ese `server.cjs` con el Node integrado
  de Electron (`ELECTRON_RUN_AS_NODE`), pasando `GENESUS_WEB_DIST` a la UI.
- `electron-builder` (config en `apps/desktop/package.json`) produce el instalador
  NSIS con acceso directo en el escritorio.

Pendiente de validar en Fase B: que el bundle del server resuelva todas las deps
(supabase-js, ws) bajo el Node de Electron; ajustar `external` si hace falta.

### Seguridad
- `contextIsolation: true`, `nodeIntegration: false`, preload mínimo.
- Enlaces externos se abren en el navegador del sistema (`setWindowOpenHandler`).
- Las llaves siguen solo en `apps/server/.env` (el server local las lee; la UI nunca).
- Para el instalador distribuible se debe mover la API key al keychain del SO
  (`safeStorage`) en vez de `.env` — pendiente de Fase B.
