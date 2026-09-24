alter table watchlist add column if not exists starred boolean not null default false;
alter table watchlist add column if not exists bear_streak integer not null default 0;
alter table watchlist add column if not exists trend_tag text null;

update watchlist set starred = true;
