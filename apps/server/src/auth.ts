import { timingSafeEqual } from 'node:crypto';
import { decodeJwt, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from './env.js';

let warned = false;

export interface AuthContext {
  userId: string;
  token: string | null;
}

/**
 * Valida el JWT de Supabase en cada request (HS256 con SUPABASE_JWT_SECRET).
 * Sin secreto configurado opera en modo desarrollo con un usuario fijo —
 * se reporta en /api/health, nunca silenciosamente en producción.
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<AuthContext | null> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;

  // Con un Bearer presente: si hay JWT secret lo verificamos; si no, decodificamos
  // el `sub` y delegamos la verificación real a Supabase (RLS rechaza tokens
  // inválidos en cada escritura). Esto da memoria permanente sin exigir el secret.
  if (token) {
    try {
      let sub: string | null;
      if (env.SUPABASE_JWT_SECRET) {
        const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
        const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
        sub = typeof payload.sub === 'string' ? payload.sub : null;
      } else {
        const payload = decodeJwt(token);
        sub = typeof payload.sub === 'string' ? payload.sub : null;
      }
      if (!sub) throw new Error('sub ausente');
      return { userId: sub, token };
    } catch {
      await reply.code(401).send({ error: 'Token inválido o expirado' });
      return null;
    }
  }

  // Sin token: modo desarrollo (usuario fijo, memoria en el server).
  if (!warned) {
    req.log.warn('Sin token Bearer: modo desarrollo con usuario fijo. Inicia sesión para memoria permanente.');
    warned = true;
  }
  return { userId: '00000000-0000-0000-0000-000000000001', token: null };
}

// --------------------------------------------------------------------------
// Rate limiting en memoria (por usuario, ventana deslizante de 60 s).
// --------------------------------------------------------------------------
const hits = new Map<string, number[]>();

export function rateLimitOk(key: string): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const list = (hits.get(key) ?? []).filter((t) => t > windowStart);
  if (list.length >= env.RATE_LIMIT_PER_MINUTE) {
    hits.set(key, list);
    return false;
  }
  list.push(now);
  hits.set(key, list);
  return true;
}

// --------------------------------------------------------------------------
// Puerta de acceso remoto.
// --------------------------------------------------------------------------
/**
 * Exige la llave de acceso cuando GENESUS_ACCESS_TOKEN está definida.
 *
 * POR QUÉ EXISTE: `authenticate()` sin Bearer NO rechaza — devuelve el usuario
 * local fijo y deja pasar la petición. Eso está bien mientras el servidor solo
 * escuche en casa, pero al publicarlo (túnel o VPS) convierte la API entera en
 * pública: cualquiera que dé con la URL puede leer la memoria, gastar el
 * presupuesto de IA y, con PC_CONTROL_REMOTE encendido, ejecutar comandos.
 *
 * La llave viaja en `x-genesus-token`. Se acepta también `?t=` una sola vez
 * para el primer arranque de la app del teléfono, que la guarda y ya no la
 * vuelve a poner en la URL (una URL con secreto queda en historiales y logs).
 *
 * Devuelve true si la petición puede continuar.
 */
export async function requireAccessToken(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const expected = env.GENESUS_ACCESS_TOKEN;
  if (!expected) return true; // sin llave configurada: comportamiento de siempre

  const header = req.headers['x-genesus-token'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const fromQuery = (req.query as Record<string, unknown> | undefined)?.t;
  const got = fromHeader ?? (typeof fromQuery === 'string' ? fromQuery : undefined);

  if (got && timingSafeEqualStr(got, expected)) return true;

  await reply.code(401).send({ error: 'Llave de acceso inválida o ausente' });
  return false;
}

/** Comparación en tiempo constante: evita adivinar la llave midiendo respuestas. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * ¿La petición viene de esta misma máquina? Se usa para que el control del PC
 * siga funcionando en la app de escritorio sin quedar abierto desde internet.
 * OJO: un túnel (cloudflared, ngrok) se conecta a localhost, así que sus
 * peticiones PARECEN locales. Por eso el control remoto del PC exige además
 * PC_CONTROL_REMOTE, y no se fía solo de la IP.
 */
export function isLocalRequest(req: FastifyRequest): boolean {
  const ip = req.ip;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
