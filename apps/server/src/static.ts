import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Sirve la interfaz web compilada (apps/web/dist) desde el mismo servidor.
 * Así la app de escritorio (Electron) carga una sola URL: UI + API juntas.
 * Si no hay build, no hace nada (modo dev usa Vite por separado).
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

export function webDistPath(): string {
  // App empaquetada: ruta inyectada por Electron. Dev: ../web/dist desde el server.
  if (process.env.GENESUS_WEB_DIST) return process.env.GENESUS_WEB_DIST;
  return resolve(process.cwd(), '..', 'web', 'dist');
}

export function registerStatic(app: FastifyInstance): boolean {
  const dist = webDistPath();
  const indexHtml = join(dist, 'index.html');
  if (!existsSync(indexHtml)) return false;

  app.setNotFoundHandler((req, reply) => {
    // Las rutas de API/v1 que no existen sí son 404 reales.
    if (req.url.startsWith('/api/') || req.url.startsWith('/v1/')) {
      void reply.code(404).send({ error: 'No encontrado' });
      return;
    }
    // Intenta servir un archivo estático; si no, devuelve index.html (SPA).
    const rel = normalize(decodeURIComponent(req.url.split('?')[0] ?? '/')).replace(/^(\.\.[/\\])+/, '');
    const candidate = join(dist, rel);
    if (rel !== '/' && candidate.startsWith(dist) && existsSync(candidate) && extname(candidate)) {
      const ct = MIME[extname(candidate)] ?? 'application/octet-stream';
      void reply.header('content-type', ct).send(readFileSync(candidate));
      return;
    }
    void reply.header('content-type', 'text/html; charset=utf-8').send(readFileSync(indexHtml));
  });
  return true;
}
