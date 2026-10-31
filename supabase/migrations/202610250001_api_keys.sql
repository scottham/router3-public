begin;
-- API keys on top of x402 channels. Each key owns one channel whose payer is
-- the user's wallet and whose payer authorizer is a key the gateway holds for
-- that API key: the wallet signs the deposits, the gateway signs the vouchers
-- for what the key's requests cost. Vouchers only move money to the
-- receiver (the Treasury), and the payer can always withdraw on-chain.
create table private.api_keys (
  id uuid primary key default gen_random_uuid(),
  payer text not null check(payer ~ '^0x[0-9a-f]{40}$'),
  name text not null check(length(name) between 1 and 80),
  prefix text not null,
  token_hash bytea not null unique,
  authorizer text not null unique check(authorizer ~ '^0x[0-9a-f]{40}$'),
  encrypted_authorizer jsonb not null,
  salt text not null check(salt ~ '^0x[0-9a-f]{64}$'),
  channel_id text not null unique check(channel_id ~ '^0x[0-9a-f]{64}$'),
  state text not null default 'active' check(state in ('active','revoked')),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index api_keys_payer_idx on private.api_keys(payer);
create trigger api_keys_touch before update on private.api_keys for each row execute function private.touch_x402_updated_at();

-- Holds of a key's in-flight requests are the running rows on its channel.
create index x402_requests_running_channel_idx on private.x402_requests(channel_id) where status='running';

-- Which key a request was made with (null: a payer-signed x402 request).
alter table private.x402_requests add column api_key_id uuid references private.api_keys(id) on delete restrict;
create index x402_requests_api_key_idx on private.x402_requests(api_key_id,created_at desc) where api_key_id is not null;
commit;
