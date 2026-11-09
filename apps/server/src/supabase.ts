import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env, hasSupabase } from './env.js';

let adminClient: SupabaseClient | null = null;
let anonClient: SupabaseClient | null = null;

/**
 * fetch con timeout duro. Sin esto, si Supabase está pausado/caído, cada
 * llamada (memoria, conversaciones, notificaciones…) puede colgarse por
 * minutos y el chat entero queda congelado esperando una respuesta que nunca
 * llega. Con timeout, falla rápido y el resto de la app (que ya tiene
 * fallbacks) puede degradar con gracia en vez de trabarse.
 */
function fetchWithTimeout(timeoutMs = 8000) {
  return (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
    const [input, init] = args;
    return fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  };
}

/**
 * Cliente con service_role (opcional). Si no hay service key, devolvemos null y
 * la app opera con el cliente anónimo + JWT del usuario (patrón seguro por RLS).
 */
export function supabase(): SupabaseClient | null {
  if (!env.SUPABASE_URL) return null;
  if (env.SUPABASE_SERVICE_KEY) {
    if (!adminClient) {
      adminClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        global: { fetch: fetchWithTimeout() },
      });
    }
    return adminClient;
  }
  return null;
}

/** Cliente anónimo (llave pública). Solo lectura del catálogo bajo RLS. */
export function supabaseAnon(): SupabaseClient | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  if (!anonClient) {
    anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: { fetch: fetchWithTimeout() },
    });
  }
  return anonClient;
}

/**
 * Cliente con el JWT del usuario: las escrituras pasan por RLS scoped a
 * auth.uid(). Es la vía que usa la IA personal para persistir memoria,
 * registro de preguntas y departamentos automáticos sin service_role.
 */
export function supabaseForUser(token: string): SupabaseClient | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` }, fetch: fetchWithTimeout() },
  });
}

/** Cualquier cliente de lectura disponible (admin > anon). */
export function supabaseRead(): SupabaseClient | null {
  return supabase() ?? supabaseAnon();
}

export { hasSupabase };

// --------------------------------------------------------------------------
// Sonda real de alcanzabilidad.
// --------------------------------------------------------------------------
/**
 * ¿Supabase responde de verdad? `hasSupabase` solo dice que hay URL y llave en
 * el .env, no que el proyecto esté vivo: un proyecto PAUSADO pierde su DNS y
 * cada escritura muere con "fetch failed" mientras /api/health seguía
 * reportando "conectado". Esta sonda mira la realidad y cachea 30 s para no
 * castigar al health check.
 */
let probe: { at: number; ok: boolean; detail: string } | null = null;

export async function supabaseReachable(
  force = false,
): Promise<{ ok: boolean; detail: string }> {
  if (!hasSupabase) return { ok: false, detail: 'sin configurar' };
  if (!force && probe && Date.now() - probe.at < 30_000) {
    return { ok: probe.ok, detail: probe.detail };
  }
  let ok = false;
  let detail = '';
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/`, {
      method: 'GET',
      headers: { apikey: env.SUPABASE_ANON_KEY ?? '' },
      signal: AbortSignal.timeout(6000),
    });
    ok = res.ok || res.status === 401 || res.status === 404; // responde = vivo
    detail = ok ? `HTTP ${res.status}` : `HTTP ${res.status}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // DNS caído = proyecto pausado o borrado (Supabase retira el subdominio).
    detail = /fetch failed|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)
      ? 'inalcanzable (proyecto pausado/borrado o sin red)'
      : msg;
  }
  probe = { at: Date.now(), ok, detail };
  return { ok, detail };
}
