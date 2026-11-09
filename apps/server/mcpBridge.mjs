import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * Puente MCP para que Hermes Agent (u otro cliente MCP) pueda preguntarle
 * directamente al cerebro/memoria real de GENESUS OS, sin duplicar memoria
 * ni lógica: solo reenvía a POST /api/assistant/ask del server local.
 */

const GENESUS_URL = process.env.GENESUS_URL || 'http://localhost:8787';

const server = new McpServer({ name: 'genesus', version: '1.0.0' });

server.tool(
  'ask_genesus',
  'Pregunta al cerebro personal de GENESUS OS (memoria permanente real de Rodolfo, Supabase + Claude). ' +
    'Úsala para cualquier pregunta sobre contexto personal, recordatorios, o cosas que Rodolfo ya le contó a GENESUS.',
  { question: z.string().describe('La pregunta en español para GENESUS') },
  async ({ question }) => {
    try {
      const res = await fetch(`${GENESUS_URL}/api/assistant/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      if (!res.ok) {
        if (res.status === 402) {
          return {
            content: [
              { type: 'text', text: 'GENESUS alcanzó su presupuesto diario de IA. Intenta más tarde.' },
            ],
          };
        }
        let detail = '';
        try {
          detail = (await res.json())?.error ?? '';
        } catch {
          // sin cuerpo JSON, se ignora
        }
        return {
          content: [
            { type: 'text', text: `GENESUS respondió con error (HTTP ${res.status})${detail ? `: ${detail}` : ''}.` },
          ],
        };
      }
      const data = await res.json();
      return { content: [{ type: 'text', text: data.answer ?? '(GENESUS no devolvió respuesta)' }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: `No se pudo contactar a GENESUS (¿está corriendo "pnpm dev" en ${GENESUS_URL}?): ${message}`,
          },
        ],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
