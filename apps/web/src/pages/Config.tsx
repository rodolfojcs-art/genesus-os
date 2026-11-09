import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Panel, Pill, Spinner } from '../components/ui';

interface ConfigData {
  presupuestoDiarioUsd: number;
  maxAgentesConcurrentes: number;
  profundidadMaxima: number;
  autoAprobarBajoUsd: number;
  n8n: string;
  whatsapp: string;
  supabase: string;
  anthropic: string;
  cola: string;
}

export function Config() {
  const config = useQuery({ queryKey: ['config'], queryFn: () => api<ConfigData>('/api/config') });
  const [testResult, setTestResult] = useState('');

  async function testWebhook() {
    setTestResult('Enviando…');
    try {
      const res = await api<{ sent: boolean; detail: string }>('/api/config/webhook-test', {
        method: 'POST',
      });
      setTestResult(res.sent ? `Enviado (${res.detail})` : `No enviado: ${res.detail}`);
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : 'error');
    }
  }

  const c = config.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-extrabold">Configuración</h1>
        <p className="text-sm text-muted">
          Las llaves (Anthropic, Supabase service) viven SOLO en el servidor (.env) — nunca en el
          navegador. Verifica en la pestaña Network: ninguna llamada sale hacia api.anthropic.com.
        </p>
      </div>

      {config.isLoading && <Spinner />}
      {c && (
        <>
          <Panel title="Estado de la infraestructura">
            <div className="grid gap-3 md:grid-cols-2">
              {(
                [
                  ['API Anthropic (proxy server-side)', c.anthropic],
                  ['Supabase (DB + Auth + Storage)', c.supabase],
                  ['Webhook n8n (misión completada)', c.n8n],
                  ['WhatsApp (Evolution API)', c.whatsapp],
                  ['Cola de misiones', c.cola],
                ] as const
              ).map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-center justify-between rounded-xl border border-line px-4 py-3"
                >
                  <span className="text-sm">{label}</span>
                  <Pill value={value} />
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Guardarraíles de costo" hint="se configuran en apps/server/.env">
            <table className="w-full text-sm">
              <tbody>
                {(
                  [
                    ['Presupuesto diario (BUDGET_DAILY_USD)', `$${c.presupuestoDiarioUsd}`],
                    ['Agentes concurrentes máx. (MAX_CONCURRENT_AGENTS)', c.maxAgentesConcurrentes],
                    ['Profundidad máx. de delegación (MAX_RECURSION_DEPTH)', c.profundidadMaxima],
                    [
                      'Auto-aprobar misiones bajo (AUTO_APPROVE_UNDER_USD)',
                      c.autoAprobarBajoUsd > 0 ? `$${c.autoAprobarBajoUsd}` : 'desactivado',
                    ],
                  ] as const
                ).map(([k, v]) => (
                  <tr key={String(k)} className="border-b border-dashed border-line last:border-0">
                    <td className="py-2.5 text-muted">{k}</td>
                    <td className="py-2.5 text-right font-mono text-xs font-semibold">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel title="Prueba de webhook n8n">
            <div className="flex items-center gap-4">
              <button className="btn-primary" onClick={() => void testWebhook()}>
                Enviar evento de prueba
              </button>
              {testResult && <span className="font-mono text-xs text-muted">{testResult}</span>}
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
