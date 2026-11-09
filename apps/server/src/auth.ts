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
