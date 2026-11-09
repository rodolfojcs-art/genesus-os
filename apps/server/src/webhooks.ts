import { createHmac } from 'node:crypto';
import { env } from './env.js';

export interface MissionWebhookPayload {
  event: 'mission.completed' | 'mission.failed' | 'mission.budget_paused' | 'webhook.test';
  missionId: string;
  title: string;
  status: string;
  costUsd: number;
  at: string;
}

/** Webhook saliente hacia n8n (Fase 5). Best-effort: nunca rompe la misión. */
export async function notifyN8n(payload: MissionWebhookPayload): Promise<{ sent: boolean; detail: string }> {
  if (!env.N8N_WEBHOOK_URL) {
    return { sent: false, detail: 'N8N_WEBHOOK_URL no configurado' };
  }
  try {
    const res = await fetch(env.N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { sent: res.ok, detail: `HTTP ${res.status}` };
  } catch (err) {
    console.error('[n8n] webhook falló:', err);
    return { sent: false, detail: err instanceof Error ? err.message : 'error' };
  }
}

export interface WorkflowWebhookPayload {
  workflowId: string;
  flow: string;
  status: string;
  at: string;
}

/** Webhook saliente hacia n8n al terminar un flujo (orquestador de negocio). Best-effort. */
export async function notifyWorkflowEvent(payload: WorkflowWebhookPayload): Promise<{ sent: boolean; detail: string }> {
  if (!env.N8N_WEBHOOK_URL) {
    return { sent: false, detail: 'N8N_WEBHOOK_URL no configurado' };
  }
  try {
    const res = await fetch(env.N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'workflow.finished', ...payload }),
    });
    return { sent: res.ok, detail: `HTTP ${res.status}` };
  } catch (err) {
    console.error('[n8n] webhook de flujo falló:', err);
    return { sent: false, detail: err instanceof Error ? err.message : 'error' };
  }
}

/**
 * Webhook saliente hacia Hermes Agent — entrega notificaciones (ej. vigías)
 * por Telegram/WhatsApp/etc. sin gastar LLM (Hermes usa --deliver-only).
 * Firma HMAC-SHA256 genérica que espera el adaptador de webhooks de Hermes
 * (header X-Webhook-Signature, sin prefijo "sha256="). Best-effort: nunca rompe al llamador.
 */
export async function notifyHermes(text: string): Promise<{ sent: boolean; detail: string }> {
  if (!env.HERMES_WEBHOOK_URL || !env.HERMES_WEBHOOK_SECRET) {
    return { sent: false, detail: 'HERMES_WEBHOOK_URL/SECRET no configurados' };
  }
  try {
    const body = JSON.stringify({ message: text });
    const signature = createHmac('sha256', env.HERMES_WEBHOOK_SECRET).update(body).digest('hex');
    const res = await fetch(env.HERMES_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Webhook-Signature': signature },
      body,
    });
    return { sent: res.ok, detail: `HTTP ${res.status}` };
  } catch (err) {
    console.error('[hermes] webhook falló:', err);
    return { sent: false, detail: err instanceof Error ? err.message : 'error' };
  }
}
