-- PriceCheck: over/under-invoicing screen. New pc_ tables only; nothing
-- existing is touched. RLS on with no policies: server (service role) only.

-- Comtrade yearly trade-flow records used as price benchmarks (one row per
-- HS6 x reporter x partner x flow x year). Unit values are derived in code.
create table if not exists public.pc_benchmarks (
  id bigint generated always as identity primary key,
  hs6 text not null check (hs6 ~ '^\d{6}$'),
  reporter_m49 integer not null,          -- country that reported the flow
  partner_m49 integer not null,           -- trading partner (0 = world)
  flow text not null check (flow in ('M', 'X')),
  period integer not null,                -- year
  source text not null check (source in ('ng_imports', 'mirror_exports_to_ng', 'origin_exports_world')),
  value_usd numeric not null check (value_usd > 0),
  value_basis text not null check (value_basis in ('cif', 'fob', 'primary')),
  net_wgt_kg numeric,
  qty numeric,
  qty_unit_code integer,
  qty_unit text,
  qty_estimated boolean,
  wgt_estimated boolean,
  fetched_at timestamptz not null default now(),
  unique (hs6, reporter_m49, partner_m49, flow, period)
);
create index if not exists pc_benchmarks_lookup_idx on public.pc_benchmarks (hs6, partner_m49);

-- Every Comtrade query made, including empty ones, so they aren't repeated.
create table if not exists public.pc_benchmark_queries (
  hs6 text not null,
  reporter_m49 integer not null,
  partner_m49 integer not null,
  flow text not null,
  period integer not null,
  rows integer not null default 0,
  status text not null check (status in ('ok', 'empty', 'error')),
  fetched_at timestamptz not null default now(),
  primary key (hs6, reporter_m49, partner_m49, flow, period)
);

-- One checked invoice (proforma, commercial invoice or Form M).
create table if not exists public.pc_invoices (
  id uuid primary key default gen_random_uuid(),
  owner text check (owner is null or length(owner) >= 24),  -- private tracker key, if saved
  source text not null check (source in ('upload', 'form_m_check')),
  doc_kind text not null,
  supplier text,
  supplier_norm text,
  buyer text,
  origin text,
  origin_m49 integer,
  currency text,
  incoterm text,
  invoice_number text,
  invoice_date date,
  total numeric,
  risk_score integer check (risk_score between 0 and 100),
  summary text,
  created_at timestamptz not null default now()
);
create index if not exists pc_invoices_owner_idx on public.pc_invoices (owner);

-- Line items with the comparison against the benchmark.
create table if not exists public.pc_lines (
  id bigint generated always as identity primary key,
  invoice_id uuid not null references public.pc_invoices (id) on delete cascade,
  line_no integer not null,
  description text,
  hs_code text,
  hs6 text,
  quantity numeric,
  unit text,
  unit_price numeric,
  line_total numeric,
  net_weight_kg numeric,
  basis text,                  -- 'kg' | 'item' | ... : what the price was compared per
  basis_qty numeric,
  unit_value_usd numeric,      -- invoice price per basis, in USD
  bench_low numeric,
  bench_median numeric,
  bench_high numeric,
  bench_points integer,
  ratio numeric,               -- unit_value / bench_median
  flags jsonb not null default '[]'::jsonb,
  unique (invoice_id, line_no)
);

-- Suppliers seen per owner, for the "new supplier" flag.
create table if not exists public.pc_suppliers (
  owner text not null,
  supplier_norm text not null,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  invoices integer not null default 1,
  primary key (owner, supplier_norm)
);

alter table public.pc_benchmarks enable row level security;
alter table public.pc_benchmark_queries enable row level security;
alter table public.pc_invoices enable row level security;
alter table public.pc_lines enable row level security;
alter table public.pc_suppliers enable row level security;
