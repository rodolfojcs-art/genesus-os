/**
 * GENESUS OS — proceso principal de Electron.
 *
 * Arranca el servidor backend (que sirve UI + API en :8787) y abre GENESUS en
 * una ventana nativa. Sin terminal, sin navegador. Al cerrar, detiene el server.
 *
 * Dos modos:
 *  - DEV (hay código fuente): lanza el server con tsx desde apps/server.
 *  - EMPAQUETADO: lanza el server bundleado (resources/server/server.cjs) con el
 *    Node integrado de Electron (ELECTRON_RUN_AS_NODE), sin Node del sistema.
 */
const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

// Render por software: evita ventanas en blanco por fallas del proceso GPU
// (frecuente en escritorio remoto / drivers / múltiples instancias previas).
app.disableHardwareAcceleration();

// Instancia única: evita el caos de varias ventanas peleando por el puerto.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

const PORT = process.env.GENESUS_PORT || 8787;
const HEALTH = `http://127.0.0.1:${PORT}/api/health`;
let serverProc = null;
let win = null;
let stopping = false; // true solo cuando cerramos a propósito
let healthFails = 0;

const isPackaged = app.isPackaged;
const repoRoot = path.resolve(__dirname, '..', '..');

function startServer() {
  if (isPackaged) {
    // Server bundleado, ejecutado con el Node de Electron.
    const serverEntry = path.join(process.resourcesPath, 'server', 'server.cjs');
    const webDist = path.join(process.resourcesPath, 'web-dist');
    serverProc = spawn(process.execPath, [serverEntry], {
      cwd: path.join(process.resourcesPath, 'server'),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        GENESUS_WEB_DIST: webDist,
        PORT: String(PORT),
      },
      stdio: 'ignore',
    });
  } else {
    // Desarrollo: tsx sobre el código fuente.
    const serverDir = path.join(repoRoot, 'apps', 'server');
    serverProc = spawn('pnpm', ['exec', 'tsx', 'src/index.ts'], {
      cwd: serverDir,
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'ignore',
      shell: true,
    });
  }
  serverProc.on('error', (err) => {
    dialog.showErrorBox('GENESUS OS', `No se pudo iniciar el servidor:\n${err.message}`);
  });
  // Auto-recuperación: si el servidor muere sin que lo hayamos cerrado, reinícialo.
  serverProc.on('exit', () => {
    if (!stopping) restartServer('el servidor se detuvo');
  });
}

let restarting = false;
function restartServer(reason) {
  if (stopping || restarting) return;
  restarting = true;
  console.error(`[genesus] reiniciando servidor: ${reason}`);
  try { if (serverProc && !serverProc.killed) serverProc.kill(); } catch { /* noop */ }
  setTimeout(() => {
    startServer();
    // NUNCA win.reload() aquí: recargar la ventana borra la conversación en curso
    // (el chat, el borrador, el streaming) — eso es justo el bug que se reporta como
    // "el chat no se guarda, salta a la pantalla principal". Solo reponemos el backend;
    // el frontend (React Query) reintenta solo sus peticiones cuando el server vuelve.
    waitForServer(30000)
      .then(() => { healthFails = 0; })
      .catch(() => { /* el vigía lo reintentará en el próximo ciclo */ })
      .finally(() => { restarting = false; });
  }, 800);
}

/**
 * Vigía: si /api/health falla varias veces SEGUIDAS, reinicia solo el proceso del
 * servidor (nunca la ventana). Timeout explícito por chequeo + umbral alto para no
 * confundir "el server está ocupado generando un documento/indexando" con "murió".
 */
function startHealthWatchdog() {
  setInterval(() => {
    if (stopping || restarting) return;
    const req = http.get(HEALTH, { timeout: 8000 }, (res) => {
      res.resume();
      healthFails = res.statusCode === 200 ? 0 : healthFails + 1;
      if (healthFails >= 4) restartServer(`health respondió ${res.statusCode}`);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => { healthFails += 1; if (healthFails >= 4) restartServer('health inalcanzable'); });
  }, 30000);
}

function waitForServer(timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      http
        .get(HEALTH, (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else retry();
        })
        .on('error', retry);
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) reject(new Error('timeout esperando al servidor'));
      else setTimeout(tick, 500);
    };
    tick();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#fafbfc',
    title: 'GENESUS OS',
    icon: fs.existsSync(path.join(__dirname, 'icon.png'))
      ? path.join(__dirname, 'icon.png')
      : undefined,
    autoHideMenuBar: true,
    // Oculta hasta que el renderer confirme el primer pintado ('ready-to-show'):
    // evita la ventana en blanco que queda si se muestra antes de que Chromium
    // termine de componer el primer frame (frecuente en escritorio remoto/VM).
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  // Red de seguridad: si el evento no llega (raro, pero posible), muestra igual
  // para no dejar la app invisible para siempre.
  setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); }, 6000);
  // Si el primer intento de pintado quedó "atascado" (ventana visible pero en
  // blanco), forzar un pequeño resize suele destrabar el compositor.
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const [w, h] = win.getSize();
      win.setSize(w + 1, h);
      win.setSize(w, h);
    }, 300);
  });

  // Enlaces externos en el navegador del sistema, no dentro de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadURL(`http://127.0.0.1:${PORT}`);
  if (process.env.GENESUS_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
  win.on('closed', () => {
    win = null;
  });
}

function showSplash() {
  const splash = new BrowserWindow({
    width: 420,
    height: 260,
    frame: false,
    backgroundColor: '#14121f',
    center: true,
    resizable: false,
  });
  splash.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(`<body style="margin:0;display:grid;place-items:center;height:100vh;background:#14121f;color:#fff;font-family:system-ui">
        <div style="text-align:center">
          <svg viewBox="0 0 300 295" width="64" height="64"><polygon points="67,65 93,65 46,195 20,195" fill="#7B68FF"/><polygon points="149,50 175,50 108,235 82,235" fill="#00D4A0"/><polygon points="188,148 214,148 174,258 148,258" fill="#FFC040"/><polygon points="242,200 268,200 241,275 215,275" fill="#F06292"/></svg>
          <h2 style="font-weight:800;margin:14px 0 4px">GENESUS OS</h2>
          <p style="opacity:.6;font-size:13px;margin:0">Iniciando tu IA personal…</p>
        </div>
      </body>`),
  );
  return splash;
}

app.whenReady().then(async () => {
  const splash = showSplash();
  startServer();
  try {
    await waitForServer();
  } catch (e) {
    dialog.showErrorBox('GENESUS OS', `El servidor no respondió a tiempo.\n${e.message}`);
  }
  createWindow();
  splash.close();
  startHealthWatchdog();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function stopServer() {
  stopping = true;
  if (serverProc && !serverProc.killed) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(serverProc.pid), '/f', '/t']);
      else serverProc.kill('SIGTERM');
    } catch {
      /* noop */
    }
  }
}

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', stopServer);
