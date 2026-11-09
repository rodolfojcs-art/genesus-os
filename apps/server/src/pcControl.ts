import { spawn } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { env } from './env.js';

/**
 * Control del PC para GENESUS (agente de escritorio) — CON SALVAGUARDAS.
 *
 * Filosofía de seguridad (el PC es de Rodolfo, pero la IA puede equivocarse):
 *   - SEGURO   (solo lectura): se ejecuta directo.
 *   - CONFIRMA (modifica algo): requiere confirmación explícita del usuario.
 *   - BLOQUEADO (catastrófico/irreversible o desactiva seguridad): se rechaza.
 * Todo lo ejecutado queda en una bitácora de auditoría.
 */

export type CmdLevel = 'safe' | 'confirm' | 'blocked';

export function pcControlEnabled(): boolean {
  return env.PC_CONTROL_ENABLED && process.platform === 'win32';
}

// Patrones catastróficos / que desactivan seguridad → NUNCA se ejecutan vía GENESUS.
const BLOCKED: Array<[RegExp, string]> = [
  [/\bformat\b\s+[a-z]:/i, 'formatear una unidad'],
  [/\bdiskpart\b/i, 'particionado de disco (diskpart)'],
  [/\bcipher\b\s+\/w/i, 'borrado seguro de disco (cipher /w)'],
  [/\b(sdelete)\b/i, 'borrado seguro (sdelete)'],
  [/remove-item\b[^|]*\b-recurse\b[^|]*\b-force\b[^|]*\b[a-z]:\\?(\s|"|'|$)/i, 'borrado recursivo de la raíz/sistema'],
  [/\b(rd|rmdir)\b\s+\/s\s+\/q\s+[a-z]:\\?(\s|"|'|$)/i, 'borrado recursivo de la raíz'],
  [/\bdel\b\s+\/[sfq]\s+.*[a-z]:\\(windows|users|program)/i, 'borrado masivo de carpetas del sistema'],
  [/set-mppreference\b[^\n]*-disable/i, 'desactivar Windows Defender'],
  [/\b(stop|disable)-service\b[^\n]*windefend/i, 'detener el antivirus'],
  [/netsh\s+advfirewall\s+set\b[^\n]*\boff\b/i, 'apagar el firewall'],
  [/\b(iwr|invoke-webrequest|curl|wget)\b[^\n]*\|\s*(iex|invoke-expression)/i, 'descargar y ejecutar código de internet'],
  [/\bbcdedit\b/i, 'editar el arranque del sistema (bcdedit)'],
  [/\b(reg)\b\s+delete\s+hk(lm|ey_local_machine)\\?(system|software\\microsoft\\windows nt)/i, 'borrar claves críticas del registro'],
];

// Verbos/acciones de solo lectura → seguros.
const SAFE = [
  /^\s*(get-[a-z]+|test-path|measure-|select-|where-|sort-|format-|out-string|write-output|write-host|resolve-path|convert|compare-object|group-object)/i,
  /^\s*(dir|ls|gci|cat|type|echo|pwd|gl|whoami|hostname|systeminfo|ver|date|time|tree|find|findstr|tasklist|ipconfig|ping|nslookup|getmac|where|wmic\s+\w+\s+get|cls|clear)\b/i,
  // Lecturas de variables de entorno / automáticas (sin asignación '=').
  /^\s*\$(env:[\w:()]+|psversiontable|home|pwd|host)\s*;?\s*$/i,
];

// Acciones que cambian el estado → requieren confirmación.
const CONFIRM = [
  /\b(remove-item|del|erase|rd|rmdir|rm)\b/i,
  /\b(new-item|mkdir|md|set-content|add-content|out-file|copy-item|copy|xcopy|robocopy|move-item|move|rename-item|ren|set-itemproperty)\b/i,
  /\b(stop-process|kill|taskkill|stop-service|start-service|set-service|restart-service)\b/i,
  /\b(start-process|start|saps)\b/i,
  /\b(shutdown|restart-computer|stop-computer|logoff)\b/i,
  /\b(reg)\b\s+(add|delete|import)/i,
  /\b(schtasks|register-scheduledtask|new-scheduledtask)\b/i,
  /\b(winget|choco|scoop|pip|npm|pnpm|yarn|dotnet|cargo)\b\s+(install|uninstall|add|remove)/i,
  /\b(netsh|new-netfirewallrule|set-netfirewall)\b/i,
  /\b(git)\b\s+(push|reset\s+--hard|clean\s+-)/i,
];

// Expresiones puras de solo lectura (números, cadenas, variables, métodos estáticos).
const SAFE_EXPR = [
  /^\[[\w.]+\]::/i, // [math]::Round(...), [System.IO...]::...
  /^["'\d(@$]/, // cadena, número, subexpresión, array, variable
  /^(select|sort|where|measure|format|out|group|foreach|%)\b/i, // continuación de pipeline
];

/** Nivel de un segmento individual (entre ; o |), ya sin la asignación inicial. */
function segmentLevel(seg: string): CmdLevel {
  let s = seg.trim();
  if (!s) return 'safe';
  // Quita una asignación inicial: "$var = ..." → evalúa la parte derecha.
  s = s.replace(/^\$[\w:]+\s*=\s*/, '').trim();
  if (!s) return 'safe';
  for (const re of CONFIRM) if (re.test(s)) return 'confirm';
  for (const re of SAFE) if (re.test(s)) return 'safe';
  for (const re of SAFE_EXPR) if (re.test(s)) return 'safe';
  return 'confirm'; // segmento desconocido → conservador
}

export function classifyCommand(raw: string): { level: CmdLevel; reason?: string } {
  const cmd = raw.trim();
  if (!cmd) return { level: 'blocked', reason: 'comando vacío' };
  // Lo catastrófico se evalúa sobre el comando completo (no se puede "trocear").
  for (const [re, reason] of BLOCKED) if (re.test(cmd)) return { level: 'blocked', reason };
  // El resto: el comando es tan riesgoso como su segmento más riesgoso.
  const segments = cmd.split(/[;\n|]+/);
  let level: CmdLevel = 'safe';
  for (const seg of segments) {
    if (segmentLevel(seg) === 'confirm') level = 'confirm';
  }
  return { level };
}

// ── Auditoría ────────────────────────────────────────────────────────────────

function auditPath(): string {
  const vault = env.OBSIDIAN_VAULT_PATH ?? join(homedir(), 'GenesusVault');
  return join(vault, 'GENESUS', 'Acciones-PC.md');
}

async function audit(entry: string): Promise<void> {
  try {
    const p = auditPath();
    await mkdir(dirname(p), { recursive: true });
    const ts = new Date().toISOString();
    await appendFile(p, `- \`${ts}\` ${entry}\n`, 'utf-8');
  } catch {
    /* la auditoría no debe romper la acción */
  }
}

// ── Centro de Deshacer ───────────────────────────────────────────────────────

export interface UndoEntry { id: string; kind: 'edit' | 'overwrite'; path: string; bak: string; label: string; ts: string }

function undoLogPath(): string {
  const vault = env.OBSIDIAN_VAULT_PATH ?? join(homedir(), 'GenesusVault');
  return join(vault, 'GENESUS', 'undo-log.json');
}

async function readUndoLog(): Promise<UndoEntry[]> {
  try {
    return JSON.parse(await readFile(undoLogPath(), 'utf-8')) as UndoEntry[];
  } catch {
    return [];
  }
}

async function pushUndo(entry: Omit<UndoEntry, 'id' | 'ts'>): Promise<void> {
  try {
    const log = await readUndoLog();
    log.unshift({ ...entry, id: (globalThis.crypto?.randomUUID() ?? String(Date.now())), ts: new Date().toISOString() });
    const p = undoLogPath();
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(log.slice(0, 200), null, 2), 'utf-8');
  } catch {
    /* no romper la acción por el log */
  }
}

/** Acciones reversibles (las que dejaron respaldo .bak y aún existe). */
export async function listUndo(): Promise<UndoEntry[]> {
  const log = await readUndoLog();
  const out: UndoEntry[] = [];
  for (const e of log) {
    if (await pathExists(e.bak)) out.push(e);
  }
  return out;
}

/** Revierte una acción restaurando su respaldo .bak. */
export async function undoAction(id: string): Promise<{ ok: boolean; reason?: string; path?: string }> {
  if (!pcControlEnabled()) return { ok: false, reason: 'Control del PC desactivado' };
  const log = await readUndoLog();
  const e = log.find((x) => x.id === id);
  if (!e) return { ok: false, reason: 'acción no encontrada' };
  try {
    const original = await readFile(e.bak, 'utf-8');
    await writeFile(e.path, original, 'utf-8');
    await audit(`↩️ deshecho: \`${e.path}\` (restaurado desde .bak)`);
    // Quita la entrada del log tras deshacer.
    await writeFile(undoLogPath(), JSON.stringify(log.filter((x) => x.id !== id), null, 2), 'utf-8');
    return { ok: true, path: e.path };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'no se pudo deshacer' };
  }
}

// ── Ejecución ────────────────────────────────────────────────────────────────

export interface RunResult {
  executed: boolean;
  level: CmdLevel;
  reason?: string;
  stdout?: string;
  stderr?: string;
  code?: number | null;
  needsConfirmation?: boolean;
}

/** Ejecuta PowerShell con timeout. No interactivo, sin perfil. */
function execPowerShell(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolveExec) => {
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      resolveExec({ stdout, stderr: stderr + '\n[timeout]', code: null });
    }, timeoutMs);
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolveExec({ stdout: stdout.slice(0, 20000), stderr: stderr.slice(0, 8000), code });
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolveExec({ stdout, stderr: String(e), code: null });
    });
  });
}

/**
 * Ejecuta un comando con la política de seguridad.
 * @param confirmed el usuario aprobó explícitamente (permite nivel 'confirm').
 */
export async function runCommand(command: string, confirmed = false, timeoutMs = 60000): Promise<RunResult> {
  if (!pcControlEnabled()) {
    return { executed: false, level: 'blocked', reason: 'Control del PC desactivado (PC_CONTROL_ENABLED=0)' };
  }
  const { level, reason } = classifyCommand(command);
  if (level === 'blocked') {
    await audit(`🚫 BLOQUEADO (${reason}): \`${command.slice(0, 200)}\``);
    return { executed: false, level, reason };
  }
  if (level === 'confirm' && !confirmed) {
    return { executed: false, level, needsConfirmation: true };
  }
  const r = await execPowerShell(command, timeoutMs);
  await audit(`${level === 'safe' ? '🟢' : '🟡'} ejecutado (code ${r.code}): \`${command.slice(0, 200)}\``);
  return { executed: true, level, stdout: r.stdout, stderr: r.stderr, code: r.code };
}

/** Abre una aplicación o documento por nombre/ruta (acción de bajo riesgo). */
export async function openApp(target: string): Promise<RunResult> {
  if (!pcControlEnabled()) return { executed: false, level: 'blocked', reason: 'Control del PC desactivado' };
  const safe = target.replace(/["`$;|&]/g, '').trim();
  if (!safe) return { executed: false, level: 'blocked', reason: 'destino vacío' };
  const r = await execPowerShell(`Start-Process ${JSON.stringify(safe)}`, 15000);
  await audit(`🟢 abrir: \`${safe.slice(0, 150)}\``);
  return { executed: true, level: 'safe', stdout: r.stdout || `Abriendo ${safe}`, stderr: r.stderr, code: r.code };
}

/** Lista un directorio (solo lectura). */
export async function listDir(path: string): Promise<{ entries: Array<{ name: string; dir: boolean; size: number }> } | { error: string }> {
  if (!pcControlEnabled()) return { error: 'Control del PC desactivado' };
  try {
    const dir = resolve(path);
    const names = await readdir(dir);
    const entries = await Promise.all(
      names.slice(0, 500).map(async (name) => {
        try {
          const s = await stat(join(dir, name));
          return { name, dir: s.isDirectory(), size: s.size };
        } catch {
          return { name, dir: false, size: 0 };
        }
      }),
    );
    return { entries };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'no se pudo leer' };
  }
}

/** Lee un archivo de texto (solo lectura, acotado). */
export async function readTextFile(path: string): Promise<{ content: string } | { error: string }> {
  if (!pcControlEnabled()) return { error: 'Control del PC desactivado' };
  try {
    const content = await readFile(resolve(path), 'utf-8');
    return { content: content.slice(0, 40000) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'no se pudo leer' };
  }
}

const SYS_PATH = /^[a-z]:\\(windows|program files|program files \(x86\))/i;
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Escribe un archivo de texto (estilo Code). Crear archivo nuevo = seguro;
 * sobrescribir uno existente requiere confirmación. Rutas de sistema, bloqueadas.
 */
export async function writeTextFile(path: string, content: string, confirmed = false): Promise<RunResult> {
  if (!pcControlEnabled()) return { executed: false, level: 'blocked', reason: 'Control del PC desactivado' };
  const abs = resolve(path);
  if (SYS_PATH.test(abs)) return { executed: false, level: 'blocked', reason: 'ruta del sistema protegida' };
  const exists = await pathExists(abs);
  if (exists && !confirmed) return { executed: false, level: 'confirm', needsConfirmation: true };
  try {
    await mkdir(dirname(abs), { recursive: true });
    if (exists) {
      // Sobrescribir: respalda el original para poder deshacer.
      await writeFile(`${abs}.bak`, await readFile(abs, 'utf-8'), 'utf-8');
    }
    await writeFile(abs, content, 'utf-8');
    await audit(`${exists ? '🟡 sobrescribir' : '🟢 crear'} archivo: \`${abs}\``);
    if (exists) await pushUndo({ kind: 'overwrite', path: abs, bak: `${abs}.bak`, label: `Sobrescribir ${abs}` });
    return { executed: true, level: exists ? 'confirm' : 'safe', stdout: `${exists ? 'Sobrescrito' : 'Creado'}: ${abs}`, code: 0 };
  } catch (e) {
    return { executed: false, level: 'safe', stderr: e instanceof Error ? e.message : 'error', code: 1 };
  }
}

/**
 * Edita un archivo de texto por buscar/reemplazar. Hace un respaldo .bak antes
 * (reversible), por eso se ejecuta sin confirmación. Rutas de sistema, bloqueadas.
 */
export async function editTextFile(
  path: string,
  find: string,
  replace: string,
  all = true,
): Promise<RunResult & { replaced?: number }> {
  if (!pcControlEnabled()) return { executed: false, level: 'blocked', reason: 'Control del PC desactivado' };
  const abs = resolve(path);
  if (SYS_PATH.test(abs)) return { executed: false, level: 'blocked', reason: 'ruta del sistema protegida' };
  try {
    const original = await readFile(abs, 'utf-8');
    if (!original.includes(find)) {
      return { executed: false, level: 'safe', stderr: 'no se encontró el texto a reemplazar', code: 1 };
    }
    const replaced = all ? original.split(find).length - 1 : 1;
    const updated = all ? original.split(find).join(replace) : original.replace(find, replace);
    await writeFile(`${abs}.bak`, original, 'utf-8'); // respaldo (deshacer)
    await writeFile(abs, updated, 'utf-8');
    await audit(`🟡 editar (${replaced}x, respaldo .bak): \`${abs}\``);
    await pushUndo({ kind: 'edit', path: abs, bak: `${abs}.bak`, label: `Editar ${abs}` });
    return { executed: true, level: 'safe', stdout: `Editado ${replaced} vez(ces). Respaldo: ${abs}.bak`, code: 0, replaced };
  } catch (e) {
    return { executed: false, level: 'safe', stderr: e instanceof Error ? e.message : 'error', code: 1 };
  }
}
