alter table watchlist add column if not exists last_price numeric null;
alter table holdings add column if not exists last_price numeric null;
