import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PersonalAssistant } from './assistant.js';

/**
 * Capa de compatibilidad OpenAI para Open WebUI (y cualquier cliente OpenAI).
 *
 * Open WebUI se configura con:
 *   Base URL: http://localhost:8787/v1   ·   API key: cualquier valor
 *
 * Modelos expuestos:
 *   - genesus-personal → IA personal completa (ruteo + memoria permanente + registro)
 *
 * Pensado para uso local (Open WebUI en la misma máquina). El usuario efectivo
 * es el de modo desarrollo; con login real usa la app web.
 */

const DEV_USER = '00000000-0000-0000-0000-000000000001';

const ChatSchema = z.object({
  model: z.string().default('genesus-personal'),
  stream: z.boolean().default(false),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']).or(z.string()),
        content: z.union([
          z.string(),
          z.array(z.object({ type: z.string(), text: z.string().optional() })),
        ]),
      }),
    )
    .min(1),
});

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'object' && p && 'text' in p ? String((p as { text?: string }).text ?? '') : ''))
      .join('\n');
  }
  return '';
}

export function registerOpenAiCompat(app: FastifyInstance, assistant: PersonalAssistant): void {
  app.get('/v1/models', async () => ({
    object: 'list',
    data: [
      {
        id: 'genesus-personal',
        object: 'model',
        created: 1750000000,
        owned_by: 'genesus-technology',
      },
    ],
  }));

  app.post('/v1/chat/completions', async (req, reply) => {
    const parsed = ChatSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { message: 'cuerpo inválido', type: 'invalid_request_error' } });
    }
    const lastUser = [...parsed.data.messages].reverse().find((m) => m.role === 'user');
    const question = contentToText(lastUser?.content ?? '').trim();
    if (!question) {
      return reply.code(400).send({ error: { message: 'sin mensaje de usuario', type: 'invalid_request_error' } });
    }

    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    try {
      const result = await assistant.ask(DEV_USER, null, question);
      const footer = `\n\n—\n_${result.department.created ? 'Departamento creado' : 'Atendido por'}: ${result.department.code} (${result.department.specialty}) · memoria: ${result.relevance}_`;
      const text = result.answer + footer;

      if (parsed.data.stream) {
        reply.hijack();
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const chunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: 'genesus-personal',
          choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
        };
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        const done = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: 'genesus-personal',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };
        reply.raw.write(`data: ${JSON.stringify(done)}\n\n`);
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
        return;
      }

      return {
        id,
        object: 'chat.completion',
        created,
        model: 'genesus-personal',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'error interno';
      return reply.code(500).send({ error: { message, type: 'api_error' } });
    }
  });
}
