import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Empty, Kpi, Panel, Spinner } from '../components/ui';

interface Costs {
  dia: string;
  limiteUsd: number;
  gastadoHoyUsd: number;
  restanteUsd: number;
  llamadasHoy: number;
  porModelo: Array<{
    model: string;
    llamadas: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  }>;
}

export function Finanzas() {
  const costs = useQuery({
    queryKey: ['costs'],
    queryFn: () => api<Costs>('/api/costs/summary'),
    refetchInterval: 8000,
  });

  const c = costs.data;
  const usagePct = c ? Math.min(100, Math.round((c.gastadoHoyUsd / c.limiteUsd) * 100)) : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-extrabold">Finanzas</h1>
        <p className="text-sm text-muted">
          Costos de IA en tiempo real, presupuesto diario con corte automático y consumo por modelo.
        </p>
      </div>

      {costs.isLoading && <Spinner />}

      {c && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Kpi label="Gastado hoy" value={`$${c.gastadoHoyUsd.toFixed(4)}`} sub={c.dia} accent="var(--rose)" />
            <Kpi label="Límite diario" value={`$${c.limiteUsd.toFixed(2)}`} sub="BUDGET_DAILY_USD" accent="var(--gold)" />
            <Kpi label="Restante" value={`$${c.restanteUsd.toFixed(4)}`} sub="corte duro al agotarse" accent="var(--teal)" />
            <Kpi label="Llamadas LLM hoy" value={c.llamadasHoy} sub="todas registradas en runs" accent="var(--indigo)" />
          </div>

          <Panel title="Uso del presupuesto" hint={`${usagePct}% del límite`}>
            <div className="h-3 overflow-hidden rounded-full bg-surface2">
              <i
                className="block h-full rounded-full transition-all"
                style={{
                  width: `${usagePct}%`,
                  background: usagePct > 85 ? 'var(--rose)' : usagePct > 60 ? 'var(--gold)' : 'var(--teal)',
                }}
              />
            </div>
            <p className="mt-3 text-xs text-muted">
              Al agotar el límite, las misiones en curso pasan a «pausada por presupuesto» — nunca
              fallan en silencio. El límite se configura en el server (.env), no desde el navegador.
            </p>
          </Panel>

          <Panel title="Consumo por modelo (hoy)" hint="datos de la tabla runs">
            {c.porModelo.length === 0 && <Empty message="Sin llamadas registradas hoy." />}
            {c.porModelo.length > 0 && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left font-mono text-[10.5px] uppercase text-muted">
                    <th className="pb-2">Modelo</th>
                    <th className="pb-2 text-right">Llamadas</th>
                    <th className="pb-2 text-right">Tokens in</th>
                    <th className="pb-2 text-right">Tokens out</th>
                    <th className="pb-2 text-right">Costo</th>
                  </tr>
                </thead>
                <tbody>
                  {c.porModelo.map((m) => (
                    <tr key={m.model} className="border-b border-dashed border-line last:border-0">
                      <td className="py-2 font-mono text-xs">{m.model}</td>
                      <td className="py-2 text-right tabular-nums">{m.llamadas}</td>
                      <td className="py-2 text-right tabular-nums">{m.tokensIn.toLocaleString('es')}</td>
                      <td className="py-2 text-right tabular-nums">{m.tokensOut.toLocaleString('es')}</td>
                      <td className="py-2 text-right font-mono text-xs">${m.costUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title="Proyecciones financieras" hint="división FIN">
            <p className="text-sm text-muted">
              Las proyecciones (TIR/VAN, unit economics, escenarios) se generan como misiones de la
              división <b className="text-ink">FIN</b>. Crea una misión del tipo «proyección
              financiera de [producto]» y los departamentos FIN-001…FIN-100 producirán el modelo como
              artefacto descargable.
            </p>
          </Panel>
        </>
      )}
    </div>
  );
}
