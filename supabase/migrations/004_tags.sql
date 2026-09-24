alter table watchlist add column if not exists latest_buy_tag text null;
alter table holdings add column if not exists latest_sell_tag text null;
