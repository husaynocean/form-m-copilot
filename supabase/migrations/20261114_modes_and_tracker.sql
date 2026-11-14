-- WhatsApp sessions remember whether the user is checking an import or an export.
alter table public.wa_sessions add column if not exists mode text not null default 'import'
  check (mode in ('import', 'export'));

-- Saved transactions for the deadline tracker. Only a summary is stored (no
-- document images). Access is by an unguessable owner key held by the user;
-- the table is reachable only with the service role (RLS on, no policies).
create table if not exists public.trade_files (
  id uuid primary key default gen_random_uuid(),
  owner text not null check (length(owner) >= 24),
  kind text not null check (kind in ('form_m', 'nxp', 'form_q', 'form_a')),
  title text not null,
  reference text,
  party text,
  amount numeric,
  currency text,
  deadline_kind text not null,
  deadline_title text not null,
  basis text,
  start_label text,
  start_date date not null,
  days_total integer not null check (days_total > 0),
  deadline date generated always as (start_date + days_total) stored,
  open_issues integer not null default 0,
  email text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  reminders_sent text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists trade_files_owner_idx on public.trade_files (owner);
create index if not exists trade_files_deadline_idx on public.trade_files (deadline) where email is not null;
alter table public.trade_files enable row level security;

-- Form Q and Form A on WhatsApp; Form Q remembers the allowance already used this quarter.
alter table public.wa_sessions drop constraint if exists wa_sessions_mode_check;
alter table public.wa_sessions add constraint wa_sessions_mode_check check (mode in ('import', 'export', 'formq', 'forma'));
alter table public.wa_sessions add column if not exists fq_used numeric not null default 0 check (fq_used >= 0);
