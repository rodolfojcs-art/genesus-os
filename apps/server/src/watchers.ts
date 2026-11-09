import { groundedComplete } from './grounded.js';
import { supabaseAnon, supabaseForUser } from './supabase.js';
import { writeMemoryNote } from './vault.js';
import { notifyHermes } from './webhooks.js';
import type { BudgetGateway } from './budget.js';

/**
 * Vigías — la iniciativa propia de GENESUS. El usuario define un tema a vigilar;
 * un planificador en segundo plano lo revisa con búsqueda web cada cierto tiempo
 * y, si hay novedad, crea una notificación + memoria. Convierte "no te aviso si
 * algo cambia" en "te aviso solo".
 */

const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000001';

function clientFor(token: string | null) {
  return token ? supabaseForUser(token) : supabaseAnon();
}

export interface Watcher {
  id: string;
  query: string;
  interval_min: number;
  status: string;
  last_summary: string | null;
  last_checked: string | null;
  created_at: string;
}

export async function listWatchers(userId: string, token: string | null): Promise<Watcher[]> {
  const sb = clientFor(token);
  if (!sb) return [];
  const { data } = await sb
    .from('genesus_watchers')
    .select('*')
    .order('created_at', { ascending: false });
  return (data ?? []) as Watcher[];
}

export async function createWatcher(
  userId: string,
  token: string | null,
  query: string,
  intervalMin: number,
): Promise<Watcher | null> {
  const sb = clientFor(token);
  if (!sb) return null;
  const { data, error } = await sb
    .from('genesus_watchers')
    .insert({ user_id: userId, query, interval_min: Math.max(15, intervalMin) })
    .select('*')
    .single();
  if (error) {
    console.error(`[watchers] crear: ${error.message}`);
    return null;
  }
  return data as Watcher;
}

export async function setWatcherStatus(
  userId: string,
  token: string | null,
  id: string,
  status: 'activo' | 'pausado',
): Promise<boolean> {
  const sb = clientFor(token);
  if (!sb) return false;
  const { error } = await sb.from('genesus_watchers').update({ status }).eq('id', id);
  return !error;
}

export async function deleteWatcher(userId: string, token: string | null, id: string): Promise<boolean> {
  const sb = clientFor(token);
  if (!sb) return false;
  const { error } = await sb.from('genesus_watchers').delete().eq('id', id);
  return !error;
}

export async function listNotifications(userId: string, token: string | null) {
  const sb = clientFor(token);
  if (!sb) return [];
  const { data } = await sb
    .from('genesus_notifications')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  return data ?? [];
}

export async function unreadCount(userId: string, token: string | null): Promise<number> {
  const sb = clientFor(token);
  if (!sb) return 0;
  const { count } = await sb
    .from('genesus_notifications')
    .select('*', { count: 'exact', head: true })
    .eq('read', false);
  return count ?? 0;
}

export async function markNotificationRead(
  userId: string,
  token: string | null,
  id: string,
): Promise<boolean> {
  const sb = clientFor(token);
  if (!sb) return false;
  const { error } = await sb.from('genesus_notifications').update({ read: true }).eq('id', id);
  return !error;
}

// --------------------------------------------------------------------------
// Planificador: revisa los vigías vencidos del usuario local en segundo plano.
// --------------------------------------------------------------------------
let running = false;

export async function runDueWatchers(budget: BudgetGateway): Promise<void> {
  if (running) return;
  const sb = supabaseAnon();
  if (!sb) return;
  running = true;
  try {
    const nowIso = new Date().toISOString();
    const { data: watchers } = await sb
      .from('genesus_watchers')
      .select('*')
      .eq('status', 'activo')
      .eq('user_id', LOCAL_USER_ID);

    for (const w of (watchers ?? []) as Watcher[]) {
      const due =
        !w.last_checked ||
        Date.now() - new Date(w.last_checked).getTime() >= w.interval_min * 60_000;
      if (!due) continue;

      // Presupuesto: si queda poco, no dispares vigías (prioriza el chat)
      if ((await budget.remaining()) < 0.5) break;

      try {
        const g = await groundedComplete(
          budget,
          'Eres GENESUS vigilando un tema para Rodolfo. Busca novedades reales y recientes. ' +
            'Si NO hay nada nuevo relevante respecto al resumen previo, responde EXACTAMENTE "SIN NOVEDAD". ' +
            'Si hay novedad, da un resumen breve (máx 4 líneas) con lo nuevo y cita fuentes.',
          `TEMA A VIGILAR: ${w.query}\nRESUMEN PREVIO: ${w.last_summary ?? '(primera revisión)'}`,
          { webSearch: true, maxTokens: 800 },
        );
        const novelty = !g.text.toUpperCase().includes('SIN NOVEDAD') && g.text.trim().length > 0;

        if (novelty) {
          await sb.from('genesus_notifications').insert({
            user_id: LOCAL_USER_ID,
            watcher_id: w.id,
            title: `Novedad: ${w.query.slice(0, 80)}`,
            body: g.text,
          });
          await sb.from('brain_memory').insert({
            user_id: LOCAL_USER_ID,
            scope: 'personal',
            title: `Vigía — ${w.query.slice(0, 100)}`,
            content: g.text,
            status: 'activa',
          });
          writeMemoryNote({
            id: crypto.randomUUID(),
            title: `Vigía — ${w.query.slice(0, 80)}`,
            content: g.text,
            status: 'activa',
            department: 'VIGÍA',
            relevance: 'relevante',
          });
          notifyHermes(`Novedad — ${w.query.slice(0, 80)}\n${g.text}`).catch((err) =>
            console.error('[watchers] notifyHermes falló:', err),
          );
        }
        await sb
          .from('genesus_watchers')
          .update({ last_checked: nowIso, last_summary: novelty ? g.text : w.last_summary })
          .eq('id', w.id);
      } catch (err) {
        console.error(`[watchers] revisión falló (${w.query}):`, err);
        await sb.from('genesus_watchers').update({ last_checked: nowIso }).eq('id', w.id);
      }
    }
  } finally {
    running = false;
  }
}

export function startScheduler(budget: BudgetGateway): void {
  // Revisa cada 2 minutos qué vigías están vencidos. (Para 24/7 real, desplegar
  // el servidor siempre encendido — ver README/roadmap.)
  setInterval(() => {
    runDueWatchers(budget).catch((err) => console.error('[scheduler]', err));
  }, 120_000);
}
