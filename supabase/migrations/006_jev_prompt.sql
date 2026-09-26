alter table judgments add column if not exists prompt jsonb null;
alter table watchlist add column if not exists prompt jsonb null;
alter table holdings add column if not exists prompt jsonb null;
