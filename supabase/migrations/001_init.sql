-- A股 Jev 观察助手 — 初始 schema

create extension if not exists "pgcrypto";

-- 观察池
create table if not exists watchlist (
  id uuid primary key default gen_random_uuid(),
  market text not null check (market in ('sh', 'sz', 'bj')),
  code text not null,
  name text not null,
  source text not null check (source in ('ai', 'manual')),
  score numeric null,
  added_at timestamptz not null default now(),
  unique (market, code)
);

-- 持仓
create table if not exists holdings (
  id uuid primary key default gen_random_uuid(),
  market text not null check (market in ('sh', 'sz', 'bj')),
  code text not null,
  name text not null,
  quantity int not null check (quantity > 0),
  added_at timestamptz not null default now(),
  unique (market, code)
);

-- 任务运行
create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('discover', 'poll')),
  status text not null check (status in ('running', 'completed')),
  progress jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz null
);

-- 判断历史
create table if not exists judgments (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  market text not null,
  code text not null,
  kind text not null check (kind in ('score', 'buy', 'sell')),
  probability numeric not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists judgments_market_code_created_idx
  on judgments (market, code, created_at desc);

create index if not exists runs_status_type_idx
  on runs (status, type, created_at desc);

-- RLS：开启且不建策略 → 仅 service_role 可访问
alter table watchlist enable row level security;
alter table holdings enable row level security;
alter table runs enable row level security;
alter table judgments enable row level security;
