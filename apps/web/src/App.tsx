import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Logo } from '@genesus/ui';
import { api, supabase } from './api';
import { CommandCenter } from './pages/CommandCenter';
import { Asistente } from './pages/Asistente';
import { Boveda } from './pages/Boveda';
import { Misiones } from './pages/Misiones';
import { Producto } from './pages/Producto';
import { Fabrica } from './pages/Fabrica';
import { Crm } from './pages/Crm';
import { Finanzas } from './pages/Finanzas';
import { Admin } from './pages/Admin';
import { Config } from './pages/Config';

interface Health {
  ok: boolean;
  red: { divisions: number; agents: number; subagents: number };
  anthropic: string;
  supabase: string;
  presupuesto: { limiteDiarioUsd: number; restanteUsd: number };
}

function Topbar() {
  const { data } = useQuery({
    queryKey: ['health'],
    queryFn: () => api<Health>('/api/health'),
    refetchInterval: 15_000,
  });
  return (
    <header className="sticky top-0 z-50 flex h-16 items-center gap-5 border-b border-line bg-white/90 px-6 backdrop-blur">
      <div className="flex items-center gap-2.5">
        <Logo size={30} />
        <span className="font-display text-[17px] font-extrabold">
          GENESUS <em className="not-italic text-indigo">OS</em>
        </span>
      </div>
      <div className="ml-auto flex items-center gap-4 font-mono text-[11px] text-muted">
        <span className="flex items-center gap-1.5 font-semibold text-teal">
          <span
            className={`h-[7px] w-[7px] rounded-full ${data?.ok ? 'bg-teal animate-pulse' : 'bg-rose'}`}
          />
          {data?.ok ? 'RED ACTIVA' : 'SIN CONEXIÓN'}
        </span>
      </div>
    </header>
  );
}

function Login({ onLocal }: { onLocal: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'login' | 'signup'>('login');

  async function submit() {
    setError('');
    setInfo('');
    if (!supabase) return;
    setBusy(true);
    const fn =
      mode === 'login'
        ? supabase.auth.signInWithPassword({ email, password })
        : supabase.auth.signUp({ email, password });
    const { error: err } = await fn;
    setBusy(false);
    if (err) {
      // El SMTP gratuito de Supabase limita correos; el modo local evita todo eso.
      setError(
        err.message.includes('rate limit')
          ? 'Supabase limitó el envío de correos. Usa "Entrar en modo local" abajo — tu memoria igual es permanente.'
          : err.message,
      );
    } else if (mode === 'signup') {
      setInfo('Cuenta creada. Si pide confirmar correo, usa el modo local mientras tanto.');
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg">
      <div className="panel w-full max-w-sm p-8">
        <div className="mb-6 flex items-center gap-3">
          <Logo size={36} />
          <div>
            <div className="font-display text-lg font-extrabold">GENESUS OS</div>
            <div className="text-xs text-muted">Genesus Technology LLC</div>
          </div>
        </div>

        {/* Modo local: tu IA personal sin fricción de login. Memoria permanente. */}
        <button className="btn-primary mb-2 w-full justify-center" onClick={onLocal}>
          Entrar en modo local
        </button>
        <p className="mb-5 text-center text-[11px] text-muted">
          Recomendado para uso personal en esta PC. Memoria y bóveda permanentes.
        </p>

        <div className="mb-4 flex items-center gap-3 text-[10px] uppercase tracking-wider text-muted">
          <span className="h-px flex-1 bg-line" /> o con cuenta <span className="h-px flex-1 bg-line" />
        </div>

        <label className="label">Correo</label>
        <input className="input mb-3" value={email} onChange={(e) => setEmail(e.target.value)} />
        <label className="label">Contraseña</label>
        <input
          className="input mb-4"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="mb-3 text-sm text-rose">{error}</p>}
        {info && <p className="mb-3 text-sm text-teal">{info}</p>}
        <button
          className="btn-ghost w-full justify-center"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? '…' : mode === 'login' ? 'Entrar' : 'Crear cuenta'}
        </button>
        <button
          className="mt-3 w-full text-center text-xs text-muted hover:text-indigo"
          onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
        >
          {mode === 'login' ? '¿No tienes cuenta? Regístrate' : 'Ya tengo cuenta'}
        </button>
      </div>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<boolean | null>(supabase ? null : true);
  const [localMode, setLocalMode] = useState<boolean>(
    () => localStorage.getItem('genesus_local_mode') === '1',
  );
  const { pathname } = useLocation();
  // Pantalla completa (sin caja centrada) para las áreas de trabajo 20/80.
  const fullBleed = pathname === '/' || pathname === '/asistente' || pathname === '/boveda';

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => setSession(Boolean(data.session)));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(Boolean(s)));
    return () => sub.subscription.unsubscribe();
  }, []);

  function enterLocal() {
    localStorage.setItem('genesus_local_mode', '1');
    setLocalMode(true);
  }

  if (session === null && !localMode) return null;
  if (!session && !localMode) return <Login onLocal={enterLocal} />;

  return (
    <div className="min-h-screen">
      <Topbar />
      <main className={fullBleed ? 'px-3 pb-3 pt-3' : 'mx-auto max-w-[1240px] px-6 pb-20 pt-8'}>
        <Routes>
          {/* GENESUS abre directo en el chat — Command Center pasó a /command-center. */}
          <Route path="/" element={<Asistente />} />
          <Route path="/asistente" element={<Asistente />} />
          <Route path="/command-center" element={<CommandCenter />} />
          <Route path="/boveda" element={<Boveda />} />
          <Route path="/misiones" element={<Misiones />} />
          <Route path="/producto" element={<Producto />} />
          <Route path="/fabrica" element={<Fabrica />} />
          <Route path="/crm" element={<Crm />} />
          <Route path="/finanzas" element={<Finanzas />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/config" element={<Config />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {!fullBleed && (
        <footer className="border-t border-line px-6 py-6 text-center font-mono text-[11px] text-muted">
          GENESUS OS · Genesus Technology LLC · Cadet Holdings Corp. — El trabajo inteligente habla
          español.
        </footer>
      )}
    </div>
  );
}
