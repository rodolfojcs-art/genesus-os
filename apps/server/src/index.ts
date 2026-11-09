// Polyfill de WebSocket para el Node 20 de Electron (supabase-js lo requiere al
// construirse; Node 22+ ya lo trae global). Debe ir ANTES de crear el cliente.
import WS from 'ws';
const g = globalThis as unknown as { WebSocket?: unknown };
if (!g.WebSocket) g.WebSocket = WS;

import Fastify from 'fastify';
import { env, hasAnthropic, hasSupabase } from './env.js';
import { authenticate } from './auth.js';
import { createBudgetGateway } from './budget.js';
import { createLlmCaller } from './llm.js';
import { MissionService } from './missions.js';
import { PersonalAssistant } from './assistant.js';
import { createQueue } from './queue.js';
import { ensureVault } from './vault.js';
import { startScheduler } from './watchers.js';
import { startRoutineScheduler } from './routines.js';
import { registerOpenAiCompat } from './openaiCompat.js';
import { registerStatic } from './static.js';
import { hydrateFromSupabase, networkCounts } from './registry.js';
import { registerRoutes } from './routes.js';
import { supabaseReachable } from './supabase.js';

async function main(): Promise<void> {
  // bodyLimit 30 MB: permite enviar imágenes (base64) para razonamiento multimodal.
  const app = Fastify({ logger: { level: 'info' }, bodyLimit: 30 * 1024 * 1024 });

  // Parser tolerante: acepta POST sin cuerpo (ej. /approve) y cualquier
  // content-type; los esquemas Zod de cada ruta validan el contenido real.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    if (!body || (typeof body === 'string' && body.trim() === '')) {
      done(null, null);
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(null, null);
    }
  });

  // CORS (manual, sin dependencias extra)
  app.addHook('onRequest', async (req, reply) => {
    reply.header('access-control-allow-origin', (req.headers.origin as string | undefined) ?? '*');
    reply.header('access-control-allow-headers', 'authorization, content-type');
    reply.header('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      await reply.code(204).send();
    }
  });

  // Autenticación: toda la API excepto /api/health
  app.decorateRequest('userId', '');
  app.decorateRequest('userToken', null);
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url === '/api/health') return;
    const auth = await authenticate(req, reply);
    if (!auth) return; // 401 ya enviado
    req.userId = auth.userId;
    req.userToken = auth.token;
  });

  const budget = createBudgetGateway();
  const llm = createLlmCaller(budget);
  const queue = await createQueue();
  const missions = new MissionService(llm, queue);
  const assistant = new PersonalAssistant(llm);
  await queue.start((missionId) => missions.run(missionId));

  const hydration = await hydrateFromSupabase();

  await registerRoutes(app, { budget, llm, missions, queue, assistant });
  registerOpenAiCompat(app, assistant);
  const servingUi = registerStatic(app); // sirve apps/web/dist si existe (app de escritorio)

  // Bóveda local (clon de Obsidian): siempre activa. Crea estructura e
  // indexa a BRAIN las notas que el usuario haya dejado en GENESUS/Notas.
  const root = ensureVault();
  const sync = await assistant.syncObsidian('00000000-0000-0000-0000-000000000001', null);
  app.log.info(`Bóveda local en ${root} · notas importadas: ${sync.imported}`);

  // Proactividad: planificador de vigías (revisa temas y notifica solo).
  startScheduler(budget);
  app.log.info('Planificador de vigías activo (revisión cada 2 min de los vencidos).');
  startRoutineScheduler();
  app.log.info('Planificador de rutinas activo (revisión cada minuto).');
  app.log.info(servingUi ? 'UI servida desde apps/web/dist (modo app de escritorio).' : 'UI no compilada (usa Vite en dev).');

  await app.listen({ port: env.PORT, host: env.HOST });

  const counts = networkCounts();
  app.log.info(
    `GENESUS OS server listo · red [${hydration.source}]: ${counts.divisions} divisiones / ${counts.agents} agentes / ${counts.subagents} subagentes`,
  );
  const sb = await supabaseReachable(true);
  const sbLabel = !hasSupabase ? 'modo demo' : sb.ok ? 'ok' : `CAIDO (${sb.detail})`;
  app.log.info(
    `anthropic=${hasAnthropic ? 'ok' : env.SIMULATE_LLM ? 'SIMULADO' : 'SIN CONFIGURAR'} · supabase=${sbLabel} · cola=${queue.kind} · presupuesto diario=$${env.BUDGET_DAILY_USD}`,
  );
  if (hasSupabase && !sb.ok) {
    app.log.warn(
      `MEMORIA PERMANENTE NO DISPONIBLE: Supabase no responde (${sb.detail}). ` +
        `Conversaciones, memoria, misiones, vigías y notificaciones NO se van a guardar. ` +
        `Si el proyecto está pausado en supabase.com, reactívalo y reinicia GENESUS.`,
    );
  }
}

main().catch((err) => {
  console.error('Fallo fatal al iniciar el server:', err);
  process.exit(1);
});
