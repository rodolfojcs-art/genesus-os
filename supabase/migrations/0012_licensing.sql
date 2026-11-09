-- ============================================================================
-- GENESUS — SISTEMA DE LICENCIAMIENTO
-- Migración: licensing_system
-- Stack: PostgreSQL 17 (Supabase)
-- Autor: AXIOM Setup · Genesus Technology LLC
-- ----------------------------------------------------------------------------
-- Modelo de planes:
--   Free        → hasta 5 terminales · límite 2h/día Y/O 50 operaciones/día
--   Teams       → hasta 10 terminales · mensual/anual
--   Enterprise  → hasta 25 terminales · mensual/anual
--   Custom      → 25+ terminales · a medida
--   Perpetua    → pago anual (licencia + acceso a actualizaciones)
-- ============================================================================

-- ---------- EXTENSIONES ----------
create extension if not exists pgcrypto;

-- ---------- ENUMS ----------
do $$ begin
  create type plan_code as enum ('free','teams','enterprise','custom','perpetual');
exception when duplicate_object then null; end $$;

do $$ begin
  create type billing_cycle as enum ('free','monthly','annual','perpetual');
exception when duplicate_object then null; end $$;

do $$ begin
  create type license_status as enum ('trial','active','past_due','expired','suspended','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type activation_status as enum ('active','revoked');
exception when duplicate_object then null; end $$;

do $$ begin
  create type operations_period as enum ('day','month');
exception when duplicate_object then null; end $$;

-- ============================================================================
-- TABLAS
-- ============================================================================

-- ---------- PLANES (catálogo) ----------
create table if not exists public.plans (
  id                        uuid primary key default gen_random_uuid(),
  code                      plan_code unique not null,
  name                      text not null,
  description               text,
  max_terminals             integer,                       -- null = ilimitado / a medida
  max_users                 integer,
  daily_time_limit_minutes  integer,                       -- null = sin límite (120 = Free)
  operations_limit          integer,                       -- null = sin límite (50 = Free)
  operations_limit_period   operations_period default 'day',
  price_monthly             numeric(10,2) default 0,
  price_annual              numeric(10,2) default 0,
  is_perpetual              boolean not null default false,
  modules                   jsonb not null default '[]'::jsonb,   -- módulos incluidos
  features                  jsonb not null default '{}'::jsonb,
  is_active                 boolean not null default true,
  sort_order                integer default 0,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- ---------- EMPRESAS ----------
create table if not exists public.companies (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  legal_name      text,
  sector          text,
  country         text,
  tax_id          text,
  contact_email   text,
  contact_phone   text,
  whatsapp_number text,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------- LICENCIAS ----------
create table if not exists public.licenses (
  id                uuid primary key default gen_random_uuid(),
  license_key       text unique not null,                  -- formato GEN-XXXX-XXXX-XXXX
  company_id        uuid references public.companies(id) on delete set null,
  plan_id           uuid not null references public.plans(id),
  plan_code         plan_code not null,
  status            license_status not null default 'trial',
  billing_cycle     billing_cycle not null default 'free',
  max_terminals     integer not null default 1,            -- override por contrato (custom)
  seats_used        integer not null default 0,            -- sincronizado por trigger
  issued_at         timestamptz not null default now(),
  starts_at         timestamptz not null default now(),
  expires_at        timestamptz,                           -- null = perpetua / sin vencimiento
  updates_until     date,                                  -- acceso a actualizaciones (perpetua)
  auto_renew        boolean not null default true,
  grace_period_days integer not null default 7,
  notes             text,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint chk_max_terminals_positive check (max_terminals >= 0),
  constraint chk_seats_used_nonneg      check (seats_used >= 0)
);
create index if not exists idx_licenses_company on public.licenses(company_id);
create index if not exists idx_licenses_status  on public.licenses(status);
create index if not exists idx_licenses_key     on public.licenses(license_key);

-- ---------- ACTIVACIONES (terminales/dispositivos) ----------
create table if not exists public.license_activations (
  id           uuid primary key default gen_random_uuid(),
  license_id   uuid not null references public.licenses(id) on delete cascade,
  device_id    text not null,                              -- huella de hardware
  device_name  text,
  os           text,
  app_version  text,
  status       activation_status not null default 'active',
  activated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz,
  metadata     jsonb not null default '{}'::jsonb,
  unique (license_id, device_id)
);
create index if not exists idx_activations_license on public.license_activations(license_id);
create index if not exists idx_activations_status  on public.license_activations(status);

-- ---------- USUARIOS DE LICENCIA (asientos por persona) ----------
create table if not exists public.license_users (
  id           uuid primary key default gen_random_uuid(),
  license_id   uuid not null references public.licenses(id) on delete cascade,
  email        text not null,
  full_name    text,
  role         text not null default 'employee',           -- chairman/admin/manager/supervisor/employee
  auth_user_id uuid,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (license_id, email)
);

-- ---------- CONTADORES DE USO DIARIO (límites Free) ----------
create table if not exists public.usage_counters (
  id               uuid primary key default gen_random_uuid(),
  license_id       uuid not null references public.licenses(id) on delete cascade,
  usage_date       date not null default current_date,
  seconds_used     integer not null default 0,
  operations_count integer not null default 0,
  updated_at       timestamptz not null default now(),
  unique (license_id, usage_date)
);
create index if not exists idx_usage_license_date on public.usage_counters(license_id, usage_date);

-- ---------- SESIONES (detalle) ----------
create table if not exists public.usage_sessions (
  id               uuid primary key default gen_random_uuid(),
  license_id       uuid not null references public.licenses(id) on delete cascade,
  activation_id    uuid references public.license_activations(id) on delete set null,
  license_user_id  uuid references public.license_users(id) on delete set null,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  duration_seconds integer,
  operations_count integer not null default 0,
  created_at       timestamptz not null default now()
);
create index if not exists idx_sessions_license on public.usage_sessions(license_id);

-- ---------- SUSCRIPCIONES / PAGOS ----------
create table if not exists public.subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  license_id           uuid not null references public.licenses(id) on delete cascade,
  provider             text default 'stripe',
  external_id          text,
  status               text not null default 'active',
  amount               numeric(10,2),
  currency             text default 'USD',
  current_period_start timestamptz,
  current_period_end   timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_subscriptions_license on public.subscriptions(license_id);

-- ---------- AUDITORÍA / EVENTOS ----------
create table if not exists public.license_events (
  id         uuid primary key default gen_random_uuid(),
  license_id uuid references public.licenses(id) on delete cascade,
  event_type text not null,                                -- validate/activate/revoke/limit_reached/renew/suspend/issue
  device_id  text,
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_events_license on public.license_events(license_id, created_at desc);

-- ============================================================================
-- FUNCIONES Y TRIGGERS
-- ============================================================================

-- ---------- updated_at automático ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists trg_plans_updated     on public.plans;
drop trigger if exists trg_companies_updated  on public.companies;
drop trigger if exists trg_licenses_updated   on public.licenses;
drop trigger if exists trg_usage_updated      on public.usage_counters;
drop trigger if exists trg_subs_updated       on public.subscriptions;
create trigger trg_plans_updated     before update on public.plans          for each row execute function public.set_updated_at();
create trigger trg_companies_updated before update on public.companies      for each row execute function public.set_updated_at();
create trigger trg_licenses_updated  before update on public.licenses       for each row execute function public.set_updated_at();
create trigger trg_usage_updated     before update on public.usage_counters for each row execute function public.set_updated_at();
create trigger trg_subs_updated      before update on public.subscriptions  for each row execute function public.set_updated_at();

-- ---------- generador de clave de licencia GEN-XXXX-XXXX-XXXX ----------
create or replace function public.generate_license_key()
returns text language plpgsql as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   -- sin caracteres ambiguos
  seg text; key text := 'GEN'; i int; j int;
begin
  for i in 1..3 loop
    seg := '';
    for j in 1..4 loop
      seg := seg || substr(alphabet, 1 + floor(random()*length(alphabet))::int, 1);
    end loop;
    key := key || '-' || seg;
  end loop;
  return key;
end; $$;

-- ---------- sincroniza seats_used según activaciones activas ----------
create or replace function public.sync_seats_used()
returns trigger language plpgsql as $$
declare lic uuid;
begin
  lic := coalesce(new.license_id, old.license_id);
  update public.licenses l
     set seats_used = (
       select count(*) from public.license_activations a
        where a.license_id = lic and a.status = 'active'
     )
   where l.id = lic;
  return coalesce(new, old);
end; $$;

drop trigger if exists trg_sync_seats on public.license_activations;
create trigger trg_sync_seats
after insert or update or delete on public.license_activations
for each row execute function public.sync_seats_used();

-- ---------- impide superar el cupo de terminales ----------
create or replace function public.enforce_terminal_limit()
returns trigger language plpgsql as $$
declare max_t integer; current_active integer;
begin
  if new.status <> 'active' then return new; end if;
  select max_terminals into max_t from public.licenses where id = new.license_id;
  select count(*) into current_active
    from public.license_activations
   where license_id = new.license_id and status = 'active'
     and (TG_OP <> 'UPDATE' or id <> new.id);
  if max_t is not null and current_active >= max_t then
    raise exception 'Límite de terminales alcanzado para esta licencia (máx %).', max_t
      using errcode = 'check_violation';
  end if;
  return new;
end; $$;

drop trigger if exists trg_enforce_terminal_limit on public.license_activations;
create trigger trg_enforce_terminal_limit
before insert or update on public.license_activations
for each row execute function public.enforce_terminal_limit();

-- ---------- registra uso (suma tiempo y operaciones del día) ----------
create or replace function public.record_usage(
  p_license_id uuid, p_seconds integer default 0, p_operations integer default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row public.usage_counters%rowtype;
begin
  insert into public.usage_counters(license_id, usage_date, seconds_used, operations_count)
  values (p_license_id, current_date, greatest(p_seconds,0), greatest(p_operations,0))
  on conflict (license_id, usage_date) do update
     set seconds_used     = public.usage_counters.seconds_used + greatest(p_seconds,0),
         operations_count = public.usage_counters.operations_count + greatest(p_operations,0),
         updated_at       = now()
  returning * into v_row;
  return jsonb_build_object('seconds_used', v_row.seconds_used, 'operations_count', v_row.operations_count);
end; $$;

-- ---------- valida una licencia y devuelve su estado + límites Free ----------
create or replace function public.check_license(p_license_key text, p_device_id text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_lic public.licenses%rowtype;
  v_plan public.plans%rowtype;
  v_today public.usage_counters%rowtype;
  v_valid boolean := true; v_reason text := 'ok';
  v_time_reached boolean := false; v_ops_reached boolean := false;
begin
  select * into v_lic from public.licenses where license_key = p_license_key;
  if not found then
    return jsonb_build_object('valid', false, 'reason', 'license_not_found');
  end if;
  select * into v_plan from public.plans where id = v_lic.plan_id;

  if v_lic.status in ('suspended','cancelled','expired') then
    v_valid := false; v_reason := v_lic.status::text;
  end if;
  if v_lic.expires_at is not null and v_lic.expires_at < now() then
    v_valid := false; v_reason := 'expired';
  end if;

  select * into v_today from public.usage_counters
   where license_id = v_lic.id and usage_date = current_date;
  if found then
    if v_plan.daily_time_limit_minutes is not null
       and v_today.seconds_used >= v_plan.daily_time_limit_minutes * 60 then
      v_time_reached := true;
    end if;
    if v_plan.operations_limit is not null
       and v_today.operations_count >= v_plan.operations_limit then
      v_ops_reached := true;
    end if;
  end if;

  -- Free: la regla "Y/O" → cualquiera de los dos límites bloquea la sesión
  if v_plan.code = 'free' and (v_time_reached or v_ops_reached) then
    v_valid := false; v_reason := 'free_limit_reached';
  end if;

  insert into public.license_events(license_id, event_type, device_id, metadata)
  values (v_lic.id, 'validate', p_device_id,
          jsonb_build_object('valid', v_valid, 'reason', v_reason));

  return jsonb_build_object(
    'valid', v_valid,
    'reason', v_reason,
    'license_id', v_lic.id,
    'plan', v_plan.code,
    'status', v_lic.status,
    'max_terminals', v_lic.max_terminals,
    'seats_used', v_lic.seats_used,
    'expires_at', v_lic.expires_at,
    'updates_until', v_lic.updates_until,
    'modules', v_plan.modules,
    'limits', jsonb_build_object(
      'daily_time_limit_minutes', v_plan.daily_time_limit_minutes,
      'operations_limit', v_plan.operations_limit,
      'seconds_used_today', coalesce(v_today.seconds_used, 0),
      'operations_today', coalesce(v_today.operations_count, 0),
      'time_limit_reached', v_time_reached,
      'ops_limit_reached', v_ops_reached
    )
  );
end; $$;

-- ---------- emite una nueva licencia ----------
create or replace function public.issue_license(
  p_company_id uuid,
  p_plan_code plan_code,
  p_billing billing_cycle default 'free',
  p_max_terminals integer default null,
  p_duration_days integer default null
) returns public.licenses language plpgsql security definer set search_path = public as $$
declare
  v_plan public.plans%rowtype; v_key text; v_lic public.licenses%rowtype;
  v_status license_status; v_expires timestamptz;
begin
  select * into v_plan from public.plans where code = p_plan_code;
  if not found then raise exception 'Plan % no existe', p_plan_code; end if;

  loop
    v_key := public.generate_license_key();
    exit when not exists (select 1 from public.licenses where license_key = v_key);
  end loop;

  v_status := case when p_plan_code = 'free' then 'trial' else 'active' end;

  if p_duration_days is not null then
    v_expires := now() + (p_duration_days || ' days')::interval;
  elsif p_billing = 'monthly' then v_expires := now() + interval '30 days';
  elsif p_billing = 'annual'  then v_expires := now() + interval '365 days';
  else v_expires := null;  -- perpetua / free sin vencimiento por tiempo
  end if;

  insert into public.licenses(
    license_key, company_id, plan_id, plan_code, status, billing_cycle,
    max_terminals, expires_at, updates_until)
  values (
    v_key, p_company_id, v_plan.id, p_plan_code, v_status, p_billing,
    coalesce(p_max_terminals, v_plan.max_terminals, 1),
    v_expires,
    case when p_billing = 'perpetual' then (current_date + 365) else null end)
  returning * into v_lic;

  insert into public.license_events(license_id, event_type, metadata)
  values (v_lic.id, 'issue', jsonb_build_object('plan', p_plan_code, 'billing', p_billing));

  return v_lic;
end; $$;

-- ----------------------------------------------------------------------------
-- FUNCIONES OPERATIVAS (ciclo de vida de terminales y sesiones)
-- ----------------------------------------------------------------------------

-- ---------- activa (registra) una terminal/dispositivo ----------
-- El trigger enforce_terminal_limit valida el cupo; aquí lo capturamos
-- para devolver un JSON limpio en vez de un error crudo.
create or replace function public.activate_terminal(
  p_license_key text,
  p_device_id   text,
  p_device_name text default null,
  p_os          text default null,
  p_app_version text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_lic public.licenses%rowtype;
  v_act public.license_activations%rowtype;
begin
  select * into v_lic from public.licenses where license_key = p_license_key;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'license_not_found');
  end if;
  if v_lic.status in ('suspended','cancelled','expired') then
    return jsonb_build_object('ok', false, 'reason', v_lic.status::text);
  end if;
  if v_lic.expires_at is not null and v_lic.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  -- upsert: reactiva el dispositivo si ya existía
  insert into public.license_activations(
    license_id, device_id, device_name, os, app_version,
    status, activated_at, last_seen_at, revoked_at)
  values (v_lic.id, p_device_id, p_device_name, p_os, p_app_version,
          'active', now(), now(), null)
  on conflict (license_id, device_id) do update
     set device_name  = excluded.device_name,
         os           = excluded.os,
         app_version  = excluded.app_version,
         status       = 'active',
         last_seen_at = now(),
         revoked_at   = null
  returning * into v_act;

  insert into public.license_events(license_id, event_type, device_id, metadata)
  values (v_lic.id, 'activate', p_device_id,
          jsonb_build_object('device_name', p_device_name, 'os', p_os, 'app_version', p_app_version));

  return jsonb_build_object(
    'ok', true,
    'activation_id', v_act.id,
    'license_id', v_lic.id,
    'plan', v_lic.plan_code,
    'max_terminals', v_lic.max_terminals,
    'seats_used', (select seats_used from public.licenses where id = v_lic.id));
exception
  when check_violation then
    -- cupo de terminales alcanzado (lanzado por enforce_terminal_limit)
    insert into public.license_events(license_id, event_type, device_id, metadata)
    values (v_lic.id, 'limit_reached', p_device_id, jsonb_build_object('scope','terminals'));
    return jsonb_build_object('ok', false, 'reason', 'terminal_limit_reached',
                              'max_terminals', v_lic.max_terminals);
end; $$;

-- ---------- revoca una terminal/dispositivo ----------
create or replace function public.revoke_activation(
  p_license_key text, p_device_id text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_lic public.licenses%rowtype; v_count integer;
begin
  select * into v_lic from public.licenses where license_key = p_license_key;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'license_not_found');
  end if;

  update public.license_activations
     set status = 'revoked', revoked_at = now()
   where license_id = v_lic.id and device_id = p_device_id and status = 'active';
  get diagnostics v_count = row_count;
  if v_count = 0 then
    return jsonb_build_object('ok', false, 'reason', 'activation_not_found');
  end if;

  insert into public.license_events(license_id, event_type, device_id)
  values (v_lic.id, 'revoke', p_device_id);

  return jsonb_build_object('ok', true, 'license_id', v_lic.id,
                            'seats_used', (select seats_used from public.licenses where id = v_lic.id));
end; $$;

-- ---------- latido: actualiza la última actividad de una terminal ----------
create or replace function public.touch_activation(
  p_license_key text, p_device_id text
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.license_activations a
     set last_seen_at = now()
    from public.licenses l
   where a.license_id = l.id
     and l.license_key = p_license_key
     and a.device_id = p_device_id
     and a.status = 'active';
end; $$;

-- ---------- inicia una sesión de uso ----------
create or replace function public.start_session(
  p_license_key text,
  p_device_id   text default null,
  p_user_email  text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_lic public.licenses%rowtype;
  v_act_id uuid; v_user_id uuid; v_session_id uuid;
begin
  select * into v_lic from public.licenses where license_key = p_license_key;
  if not found then raise exception 'Licencia % no existe', p_license_key; end if;

  if p_device_id is not null then
    select id into v_act_id from public.license_activations
     where license_id = v_lic.id and device_id = p_device_id;
  end if;
  if p_user_email is not null then
    select id into v_user_id from public.license_users
     where license_id = v_lic.id and email = p_user_email;
  end if;

  insert into public.usage_sessions(license_id, activation_id, license_user_id)
  values (v_lic.id, v_act_id, v_user_id)
  returning id into v_session_id;

  if v_act_id is not null then
    update public.license_activations set last_seen_at = now() where id = v_act_id;
  end if;

  return v_session_id;
end; $$;

-- ---------- finaliza una sesión: consolida tiempo y operaciones del día ----------
create or replace function public.end_session(
  p_session_id uuid, p_operations integer default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sess  public.usage_sessions%rowtype;
  v_plan  public.plans%rowtype;
  v_today public.usage_counters%rowtype;
  v_secs  integer; v_usage jsonb;
  v_time_reached boolean := false; v_ops_reached boolean := false;
begin
  select * into v_sess from public.usage_sessions where id = p_session_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'session_not_found');
  end if;
  if v_sess.ended_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'session_already_ended');
  end if;

  v_secs := greatest(extract(epoch from (now() - v_sess.started_at))::integer, 0);

  update public.usage_sessions
     set ended_at         = now(),
         duration_seconds = v_secs,
         operations_count = greatest(p_operations, 0)
   where id = p_session_id;

  -- consolida en el contador diario (límites Free)
  v_usage := public.record_usage(v_sess.license_id, v_secs, greatest(p_operations, 0));

  -- evalúa límites del plan para registrar el evento correspondiente
  select * into v_plan from public.plans
    where id = (select plan_id from public.licenses where id = v_sess.license_id);
  select * into v_today from public.usage_counters
   where license_id = v_sess.license_id and usage_date = current_date;

  if v_plan.daily_time_limit_minutes is not null
     and v_today.seconds_used >= v_plan.daily_time_limit_minutes * 60 then
    v_time_reached := true;
  end if;
  if v_plan.operations_limit is not null
     and v_today.operations_count >= v_plan.operations_limit then
    v_ops_reached := true;
  end if;

  if v_plan.code = 'free' and (v_time_reached or v_ops_reached) then
    insert into public.license_events(license_id, event_type, metadata)
    values (v_sess.license_id, 'limit_reached',
            jsonb_build_object('time_limit_reached', v_time_reached,
                               'ops_limit_reached', v_ops_reached));
  end if;

  return jsonb_build_object(
    'ok', true,
    'session_id', p_session_id,
    'duration_seconds', v_secs,
    'usage_today', v_usage,
    'time_limit_reached', v_time_reached,
    'ops_limit_reached', v_ops_reached);
end; $$;

-- ---------- renueva / extiende una licencia ----------
create or replace function public.renew_license(
  p_license_id   uuid,
  p_billing      billing_cycle default null,
  p_duration_days integer default null
) returns public.licenses language plpgsql security definer set search_path = public as $$
declare v_lic public.licenses%rowtype; v_base timestamptz; v_billing billing_cycle;
begin
  select * into v_lic from public.licenses where id = p_license_id;
  if not found then raise exception 'Licencia % no existe', p_license_id; end if;

  v_billing := coalesce(p_billing, v_lic.billing_cycle);
  -- extiende desde el vencimiento si aún es futuro; si no, desde hoy
  v_base := greatest(coalesce(v_lic.expires_at, now()), now());

  update public.licenses
     set status        = 'active',
         billing_cycle = v_billing,
         auto_renew    = true,
         expires_at = case
           when p_duration_days is not null then v_base + (p_duration_days || ' days')::interval
           when v_billing = 'monthly'       then v_base + interval '30 days'
           when v_billing = 'annual'        then v_base + interval '365 days'
           else null   -- perpetua: sin vencimiento por tiempo
         end,
         updates_until = case
           when v_billing = 'perpetual'
             then greatest(coalesce(updates_until, current_date), current_date) + 365
           else updates_until
         end
   where id = p_license_id
   returning * into v_lic;

  insert into public.license_events(license_id, event_type, metadata)
  values (p_license_id, 'renew',
          jsonb_build_object('billing', v_billing, 'expires_at', v_lic.expires_at));

  return v_lic;
end; $$;

-- ---------- cambia el estado de una licencia (suspender / reactivar / cancelar) ----------
create or replace function public.set_license_status(
  p_license_id uuid, p_status license_status, p_reason text default null
) returns public.licenses language plpgsql security definer set search_path = public as $$
declare v_lic public.licenses%rowtype; v_event text;
begin
  update public.licenses set status = p_status
   where id = p_license_id
   returning * into v_lic;
  if not found then raise exception 'Licencia % no existe', p_license_id; end if;

  v_event := case p_status
    when 'suspended' then 'suspend'
    when 'active'    then 'renew'
    when 'cancelled' then 'cancel'
    when 'expired'   then 'expire'
    else 'update'
  end;

  insert into public.license_events(license_id, event_type, metadata)
  values (p_license_id, v_event, jsonb_build_object('status', p_status, 'reason', p_reason));

  return v_lic;
end; $$;

-- ============================================================================
-- VISTAS (panel de administración — solo accesibles vía service_role)
-- ============================================================================

-- ---------- resumen de licencias con consumo del día ----------
create or replace view public.v_license_overview as
select
  l.id,
  l.license_key,
  l.status,
  l.plan_code,
  l.billing_cycle,
  c.name              as company_name,
  p.name              as plan_name,
  p.modules,
  l.max_terminals,
  l.seats_used,
  l.issued_at,
  l.starts_at,
  l.expires_at,
  l.updates_until,
  coalesce(u.seconds_used, 0)     as seconds_used_today,
  coalesce(u.operations_count, 0) as operations_today
from public.licenses l
join public.plans p          on p.id = l.plan_id
left join public.companies c on c.id = l.company_id
left join public.usage_counters u
       on u.license_id = l.id and u.usage_date = current_date;

-- ---------- últimos eventos por licencia (auditoría) ----------
create or replace view public.v_recent_events as
select
  e.id,
  e.license_id,
  l.license_key,
  e.event_type,
  e.device_id,
  e.metadata,
  e.created_at
from public.license_events e
left join public.licenses l on l.id = e.license_id
order by e.created_at desc;

-- ============================================================================
-- SEGURIDAD (RLS)
-- ----------------------------------------------------------------------------
-- El acceso de la app de escritorio se hace vía Edge Function con service_role.
-- El cliente NO accede directo a estas tablas (RLS deniega por defecto).
-- Solo el catálogo de planes es de lectura pública.
-- ============================================================================
alter table public.plans              enable row level security;
alter table public.companies          enable row level security;
alter table public.licenses           enable row level security;
alter table public.license_activations enable row level security;
alter table public.license_users      enable row level security;
alter table public.usage_counters     enable row level security;
alter table public.usage_sessions     enable row level security;
alter table public.subscriptions      enable row level security;
alter table public.license_events     enable row level security;

drop policy if exists plans_public_read on public.plans;
create policy plans_public_read on public.plans
  for select to anon, authenticated using (is_active = true);

-- ============================================================================
-- SEED — CATÁLOGO DE PLANES
-- (precios placeholder: ajustar a la tarifa final de Genesus)
-- ============================================================================
insert into public.plans
  (code, name, description, max_terminals, max_users,
   daily_time_limit_minutes, operations_limit, operations_limit_period,
   price_monthly, price_annual, is_perpetual, modules, sort_order)
values
  ('free','Free','Sesiones limitadas para evaluación',
   5, 5, 120, 50, 'day', 0, 0, false,
   '["corporate_intelligence","capture"]'::jsonb, 1),

  ('teams','Teams','Para equipos en crecimiento',
   10, 10, null, null, 'day', 0, 0, false,
   '["corporate_intelligence","capture","optimize","connect"]'::jsonb, 2),

  ('enterprise','Enterprise','Operación completa multiempresa',
   25, 25, null, null, 'day', 0, 0, false,
   '["corporate_intelligence","capture","optimize","connect","terra_ia","gis_enterprise"]'::jsonb, 3),

  ('custom','Custom','Plan a medida (25+ terminales)',
   null, null, null, null, 'day', 0, 0, false,
   '["corporate_intelligence","capture","optimize","connect","terra_ia","gis_enterprise"]'::jsonb, 4),

  ('perpetual','Perpetua','Licencia perpetua con pago anual de actualizaciones',
   25, 25, null, null, 'day', 0, 0, true,
   '["corporate_intelligence","capture","optimize","connect","terra_ia","gis_enterprise"]'::jsonb, 5)
on conflict (code) do nothing;

-- ============================================================================
-- FIN DE LA MIGRACIÓN
-- ============================================================================
