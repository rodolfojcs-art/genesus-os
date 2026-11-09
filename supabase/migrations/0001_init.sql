-- GENESUS OS — Esquema base (master prompt §6)
-- Migración 0001: extensiones y tablas

create extension if not exists pgcrypto;
create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Red de agentes
-- ---------------------------------------------------------------------------

create table if not exists divisions (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  name        text not null,
  color       text not null,
  description text
);

create table if not exists agents (
  id            uuid primary key default gen_random_uuid(),
  division_id   uuid not null references divisions(id) on delete cascade,
  code          text unique not null,
  name          text not null,
  specialty     text not null,
  system_prompt text not null,
  model_tier    text not null check (model_tier in ('opus', 'sonnet', 'haiku')),
  status        text not null default 'activo' check (status in ('activo', 'inactivo')),
  created_at    timestamptz not null default now()
);

create table if not exists subagents (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid not null references agents(id) on delete cascade,
  code          text unique not null,
  role          text not null,
  model_tier    text not null check (model_tier in ('sonnet', 'haiku')),
  system_prompt text not null
);

create index if not exists idx_agents_division on agents(division_id);
create index if not exists idx_agents_specialty on agents using gin (to_tsvector('spanish', specialty));
create index if not exists idx_subagents_agent on subagents(agent_id);

-- ---------------------------------------------------------------------------
-- Misiones y orquestación
-- ---------------------------------------------------------------------------

create table if not exists missions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  title        text not null,
  brief        text not null,
  status       text not null default 'borrador' check (status in (
    'borrador', 'planificada', 'aprobada', 'en_ejecucion',
    'completada', 'fallida', 'pausada_por_presupuesto'
  )),
  plan         jsonb,
  budget_usd   numeric(10, 2) not null default 5,
  cost_usd     numeric(12, 6) not null default 0,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists tasks (
  id         uuid primary key default gen_random_uuid(),
  mission_id uuid not null references missions(id) on delete cascade,
  agent_id   uuid references agents(id),
  task_key   text not null,           -- id lógico dentro del plan (t1, t2…)
  depends_on uuid[] not null default '{}',
  status     text not null default 'pendiente' check (status in (
    'pendiente', 'en_ejecucion', 'completada', 'fallida', 'omitida'
  )),
  input      jsonb,
  output     jsonb,
  qa_status  text not null default 'pendiente' check (qa_status in ('pendiente', 'aprobado', 'rechazado')),
  retries    int not null default 0,
  cost_usd   numeric(12, 6) not null default 0
);

-- Log de CADA llamada LLM (guardarraíl de costos — obligatorio desde el día 1)
create table if not exists runs (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid references tasks(id) on delete set null,
  model      text not null,
  tokens_in  int not null default 0,
  tokens_out int not null default 0,
  cost_usd   numeric(12, 6) not null default 0,
  latency_ms int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists artifacts (
  id           uuid primary key default gen_random_uuid(),
  mission_id   uuid not null references missions(id) on delete cascade,
  task_id      uuid references tasks(id) on delete set null,
  kind         text not null check (kind in ('markdown', 'json', 'svg', 'csv')),
  title        text not null,
  storage_path text not null,
  meta         jsonb not null default '{}'
);

create index if not exists idx_missions_user on missions(user_id);
create index if not exists idx_tasks_mission on tasks(mission_id);
create index if not exists idx_runs_task on runs(task_id);
create index if not exists idx_runs_created on runs(created_at);
create index if not exists idx_artifacts_mission on artifacts(mission_id);

-- ---------------------------------------------------------------------------
-- Genesus BRAIN — memoria centralizada con pgvector
-- ---------------------------------------------------------------------------

create table if not exists brain_memory (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid,
  scope      text not null default 'global',
  content    text not null,
  embedding  vector(1536),
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create index if not exists idx_brain_memory_embedding
  on brain_memory using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ---------------------------------------------------------------------------
-- Fábrica, producto y CRM
-- ---------------------------------------------------------------------------

create table if not exists suppliers (
  id         uuid primary key default gen_random_uuid(),
  name       text unique not null,
  country    text,
  categories text[] not null default '{}',
  contact    jsonb not null default '{}',
  rating     numeric(3, 1),
  status     text not null default 'activo'
);

create table if not exists clients (
  id      uuid primary key default gen_random_uuid(),
  name    text unique not null,
  segment text,
  country text,
  contact jsonb not null default '{}',
  status  text not null default 'activo'
);

create table if not exists products (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  sku                text unique not null,
  status             text not null default 'diseño',
  design_artifact_id uuid references artifacts(id) on delete set null,
  specs              jsonb not null default '{}'
);

create table if not exists bom_items (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete cascade,
  component   text not null,
  qty         numeric not null default 1,
  unit        text not null default 'pieza',
  est_cost    numeric(12, 4),
  supplier_id uuid references suppliers(id) on delete set null
);

create table if not exists orders (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('produccion', 'compra', 'venta')),
  product_id uuid references products(id) on delete set null,
  qty        int not null default 1,
  status     text not null default 'pendiente',
  timeline   jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table if not exists machines (
  id      uuid primary key default gen_random_uuid(),
  name    text unique not null,
  adapter text not null check (adapter in ('simulator', 'mqtt', 'opcua')),
  config  jsonb not null default '{}',
  status  text not null default 'inactiva'
);

create index if not exists idx_bom_product on bom_items(product_id);
create index if not exists idx_orders_product on orders(product_id);

-- ---------------------------------------------------------------------------
-- Presupuesto diario (corte duro)
-- ---------------------------------------------------------------------------

create table if not exists cost_budgets (
  id        uuid primary key default gen_random_uuid(),
  day       date unique not null,
  limit_usd numeric(10, 2) not null,
  spent_usd numeric(12, 6) not null default 0
);
