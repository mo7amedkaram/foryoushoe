-- ============================================================
--  Supabase schema for the Shopify <-> joud.chat WhatsApp bridge
--  Run this in: Supabase Dashboard -> SQL Editor -> New query.
-- ============================================================

-- ------------------------------------------------------------
--  app_config : single-row configuration table.
--  We always use id = 1 (enforced by a CHECK) so the app can
--  upsert on conflict (id).
-- ------------------------------------------------------------
create table if not exists public.app_config (
  id                  integer primary key default 1,
  settings            jsonb       not null default '{}'::jsonb,
  mapping             jsonb       not null default '{}'::jsonb,
  selected_template_id text       not null default '',
  phone_number_id     text        not null default '',
  updated_at          timestamptz not null default now(),
  constraint app_config_single_row check (id = 1)
);

-- Seed the single config row if it does not exist yet.
insert into public.app_config (id, settings, mapping, selected_template_id, phone_number_id)
values (1, '{}'::jsonb, '{}'::jsonb, '', '')
on conflict (id) do nothing;

-- ------------------------------------------------------------
--  message_log : one row per send attempt (webhook or test).
-- ------------------------------------------------------------
create table if not exists public.message_log (
  id               bigserial   primary key,
  created_at       timestamptz not null default now(),
  shopify_order_id text,
  order_number     text,
  recipient_phone  text,
  template_id      text,
  variables        jsonb       not null default '{}'::jsonb,
  success          boolean     not null default false,
  response         text
);

-- Indexes: newest-first listing + idempotency lookup.
create index if not exists message_log_created_at_idx
  on public.message_log (created_at desc);

create index if not exists message_log_order_template_idx
  on public.message_log (shopify_order_id, template_id, success);

-- ------------------------------------------------------------
--  shopify_auth : single-row store of the Shopify Admin API
--  access token. The app uses the CLIENT-CREDENTIALS grant, whose
--  token expires (~24h) — `expires_at` lets the app refresh it
--  before expiry. id is fixed to 1 so the app can upsert on
--  conflict (id).
-- ------------------------------------------------------------
create table if not exists public.shopify_auth (
  id           integer primary key default 1,
  shop         text,
  access_token text,
  scope        text,
  obtained_at  timestamptz not null default now(),
  expires_at   timestamptz,
  updated_at   timestamptz not null default now(),
  constraint shopify_auth_single_row check (id = 1)
);

-- Backfill for instances created before expires_at existed.
alter table public.shopify_auth
  add column if not exists expires_at timestamptz;

-- ------------------------------------------------------------
--  Row Level Security
--  The server uses the SERVICE ROLE key, which bypasses RLS, so
--  these tables are safe with RLS enabled and NO public policies.
--  Enabling RLS prevents accidental access via the anon key.
--  (shopify_auth holds a secret token — RLS + no policies keeps it
--  unreachable through the public anon/PostgREST API.)
-- ------------------------------------------------------------
alter table public.app_config   enable row level security;
alter table public.message_log  enable row level security;
alter table public.shopify_auth enable row level security;
