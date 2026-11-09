# GENESUS OS

Plataforma de inteligencia corporativa de **Genesus Technology LLC** (genesustech.com, subsidiaria de Cadet Holdings Corp.): un agente raíz —**GENESUS** (Claude Opus)— dirige una red de **1,000 agentes departamentales** (Claude Sonnet) con **10,000 subagentes** (Claude Haiku) organizados en 10 divisiones corporativas. El usuario pide una misión; la red la descompone en un DAG, ejecuta con QA por tarea y entrega artefactos descargables.

> El trabajo inteligente habla español.

## Setup local (8 pasos)

1. Requisitos: Node ≥ 20 y pnpm ≥ 9 (`corepack enable`).
2. `pnpm install`
3. Copia `.env.example` → `apps/server/.env` y define `ANTHROPIC_API_KEY` (para probar sin costo: `SIMULATE_LLM=1` en su lugar).
4. (Opcional, recomendado) Crea un proyecto Supabase, aplica las migraciones de `supabase/migrations/` en orden (SQL Editor o `supabase db push`) y define `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`, `DATABASE_URL`.
5. `pnpm seed` — inserta 10 divisiones, 1,000 agentes, 10,000 subagentes y datos demo. Sin Supabase genera `supabase/seed.generated.json` para inspección.
6. `pnpm dev` — levanta server (`:8787`) y web (`:5173`).
7. Abre `http://localhost:5173`. Sin Supabase Auth configurado entras directo (modo dev); con Supabase, crea tu cuenta.
8. Crea tu primera misión en el módulo **Misiones**, revisa el plan y apruébalo.

## Arquitectura

```
genesus-os/
├── apps/
│   ├── web/        React 18 + Vite + TanStack Query + Tailwind (tokens Genesus, UI clara, 100% español)
│   └── server/     Fastify 5: proxy Anthropic (SSE), orquestador, presupuesto, colas, webhooks n8n
├── packages/
│   ├── core/       Dominio puro y portable: tipos, routing 3 modelos, costos, presupuesto, DAG, motor de misiones, MachineAdapter
│   ├── agents/     Taxonomía (10 div × 25 dominios × 4 enfoques), plantillas de prompts, generador y seed
│   └── ui/         Tokens de diseño + logo (spec SVG definitiva de 4 barras)
└── supabase/
    └── migrations/ Esquema completo + RLS + pgvector (BRAIN) + funciones RPC
```

```
Usuario (CEO)
   │ misión
   ▼
GENESUS (Opus) ── planning → MissionPlan (JSON validado con Zod) → APROBACIÓN DEL USUARIO
   │ aprobado
   ▼
Orquestador (DAG, máx 8 concurrentes, pg-boss/in-process)
   ├── Agente departamental (Sonnet) ←→ subagentes (Haiku; ejecución/entregable en Sonnet)
   ├── QA por tarea (Haiku) — rechazo ⇒ reintento con feedback (máx 2)
   ▼
GENESUS (Opus) ── síntesis → artefactos descargables (md/json) + webhook n8n
```

### Principios innegociables implementados

| Principio | Dónde |
|---|---|
| El frontend NUNCA llama a Anthropic | `apps/server/src/llm.ts` (proxy); verifícalo en la pestaña Network |
| Registro vs. instanciación | `packages/agents/src/generator.ts`: 11,000 definiciones persistidas; se instancian solo los agentes del plan |
| Routing de 3 modelos | `packages/core/src/routing.ts` + test que prohíbe Opus fuera del raíz |
| Guardarraíles de costo | logging de cada llamada en `runs`, `consume_budget` atómico (corte duro), `MAX_CONCURRENT_AGENTS`, dashboard Finanzas |
| Genesus BRAIN | `brain_memory` con pgvector + RPC `match_memories` |
| Núcleo portable | `packages/core` compila con lib ES2022 sin DOM (ver `ELECTRON.md`) |
| Conectores honestos | `MachineAdapter`: `simulator` funcional; stubs MQTT/OPC-UA reportan `sin configurar` |
| Separación de TerraMercado | test automático en `generator.test.ts` |

## Scripts

| Comando | Acción |
|---|---|
| `pnpm dev` | server + web en watch |
| `pnpm seed` | genera/inserta la red completa y datos demo |
| `pnpm test` | Vitest (core: routing, costos, presupuesto, DAG, orquestador · agents: generador) |
| `pnpm typecheck` | TypeScript estricto en los 5 paquetes |
| `pnpm build` | build de producción |

## Módulos de la app (8)

Command Center · GENESUS Chat / Misiones · Estudio de Producto · Fábrica · Proveedores y Clientes · Finanzas · Administración de la red · Configuración.

## Documentación

- `DEPLOY.md` — despliegue en Hetzner (nginx + systemd + SSL)
- `ELECTRON.md` — plan de empaquetado desktop
- `COSTOS.md` — unit economics por misión
- `DECISIONS.md` — decisiones técnicas tomadas durante la construcción
