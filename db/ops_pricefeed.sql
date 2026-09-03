-- Segments Cloud ops center: durable supplier price observations + event states.
-- Applied to the Supabase project as migration "ops_pricefeed_observations_and_event_states".
-- Written only by the ops-center API through the secret / service-role key.
-- RLS is enabled with no policies, so publishable (anon) keys can neither read nor write.

create table if not exists public.ops_price_observations (
  dedupe_key       text primary key,
  observed_at      timestamptz not null,
  source           text not null,
  sender           text,
  message_id       text,
  model_key        text not null,
  model_label      text not null,
  hashrate_th      numeric,
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  currency         text not null default 'USD',
  basis            text not null check (basis in ('USED','FRESH','UNKNOWN')),
  confidence       text,
  per_th           boolean not null default false,
  note             text,
  raw              text,
  inserted_at      timestamptz not null default now()
);
create index if not exists ops_price_observations_model_idx
  on public.ops_price_observations (model_key, basis, observed_at desc);
create index if not exists ops_price_observations_observed_idx
  on public.ops_price_observations (observed_at desc);

create table if not exists public.ops_event_states (
  id             text primary key,
  severity       text not null check (severity in ('WARNING','CRITICAL')),
  title          text,
  first_seen_at  timestamptz not null,
  last_seen_at   timestamptz not null,
  cleared_at     timestamptz,
  updated_at     timestamptz not null default now()
);

alter table public.ops_price_observations enable row level security;
alter table public.ops_event_states enable row level security;

comment on table public.ops_price_observations is 'Supplier price observations parsed from WhatsApp/manual price lists (ops center). Money in integer minor units.';
comment on table public.ops_event_states is 'Last known alerting state per operational event id; lets /api/events emit RECOVERY when a WARNING/CRITICAL clears.';
