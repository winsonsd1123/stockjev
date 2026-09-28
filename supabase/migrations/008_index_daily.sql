-- 上证日 K 只存一行，发现和趋势复盘共用

create table if not exists index_daily (
  id int primary key,
  bars jsonb not null,
  updated_at timestamptz not null default now(),
  constraint index_daily_singleton check (id = 1)
);
