-- Applied to the form-m-copilot Supabase project. See lib/store.ts.
create table public.wa_sessions (
  phone text primary key,
  lang text not null default 'en',
  docs jsonb not null default '{}'::jsonb,
  reported boolean not null default false,
  updated_at timestamptz not null default now()
);
create table public.wa_messages (id text primary key, created_at timestamptz not null default now());
alter table public.wa_sessions enable row level security;
alter table public.wa_messages enable row level security;
-- wa_merge_doc, wa_claim_report, wa_first_seen: atomic helpers, executable by service_role only.
