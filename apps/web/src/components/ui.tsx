import type { ReactNode } from 'react';

export function Kpi({
  label,
  value,
  sub,
  accent = 'var(--indigo)',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: string;
}) {
  return (
    <div className="panel relative overflow-hidden px-5 py-4">
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: accent }} />
      <div className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="font-display text-3xl font-extrabold tabular-nums mt-1">{value}</div>
      {sub && <div className="font-mono text-[11px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

export function Panel({
  title,
  hint,
  children,
  actions,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="panel">
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <h3 className="font-display text-[15px] font-bold">{title}</h3>
        <div className="flex items-center gap-3">
          {hint && <span className="font-mono text-[10.5px] text-muted">{hint}</span>}
          {actions}
        </div>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

const PILL_STYLES: Record<string, string> = {
  // misiones
  borrador: 'bg-surface2 text-muted',
  planificada: 'bg-indigo-soft text-indigo',
  aprobada: 'bg-indigo-soft text-indigo',
  en_ejecucion: 'bg-gold-soft text-[#B07F12]',
  completada: 'bg-teal-soft text-[#089673]',
  fallida: 'bg-rose-soft text-rose',
  pausada_por_presupuesto: 'bg-rose-soft text-rose',
  // genérico
  activo: 'bg-teal-soft text-[#089673]',
  inactivo: 'bg-surface2 text-muted',
  aprobado: 'bg-teal-soft text-[#089673]',
  rechazado: 'bg-rose-soft text-rose',
  pendiente: 'bg-surface2 text-muted',
  omitida: 'bg-surface2 text-muted',
  // conectores
  simulado: 'bg-gold-soft text-[#B07F12]',
  conectado: 'bg-teal-soft text-[#089673]',
  'sin configurar': 'bg-surface2 text-muted',
  // infraestructura
  configurado: 'bg-teal-soft text-[#089673]',
  'modo demo': 'bg-gold-soft text-[#B07F12]',
  'modo demo (memoria)': 'bg-gold-soft text-[#B07F12]',
};

export function Pill({ value }: { value: string }) {
  const cls = PILL_STYLES[value] ?? 'bg-surface2 text-muted';
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 font-mono text-[10.5px] font-semibold ${cls}`}>
      {value.replaceAll('_', ' ')}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line2 border-t-indigo" />
      {label ?? 'Cargando…'}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-rose/30 bg-rose-soft px-4 py-3 text-sm text-rose">
      {message}
    </div>
  );
}

export function Empty({ message }: { message: string }) {
  return <div className="py-8 text-center text-sm text-muted">{message}</div>;
}
