begin;

-- Internal accounting for bounded gas-reserve conversions. This migration does
-- not activate a signer, grant a wallet permission, or start a chain worker.
-- A dedicated executor may use these tables after independently verifying chain
-- policy/deposit/receipt proofs. API/Indexer roles get NO write privileges here.
create table private.gas_reserve_wallets (
  wallet_id uuid primary key references public.user_wallets(id) on delete restrict,
  app_user_id uuid not null references public.app_users(id) on delete restrict,
  chain_id bigint not null check (chain_id = 8453),
  address text not null check (address ~ '^0x[0-9a-f]{40}$'),
  token_address text not null check (token_address = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
  opening_block bigint not null check (opening_block >= 0),
  opening_block_hash text not null check (opening_block_hash ~ '^0x[0-9a-f]{64}$'),
  opening_credit_atomic numeric(78,0) not null check (opening_credit_atomic >= 0),
  opening_canonical boolean not null default true,
  paused boolean not null default false,
  halted boolean not null default false,
  halt_reason text,
  current_revision bigint not null default 0 check (current_revision >= 0),
  created_at timestamptz not null default now(),
  unique(chain_id,address)
);
create table private.gas_reserve_policies (
  wallet_id uuid not null references private.gas_reserve_wallets(wallet_id) on delete restrict,
  revision bigint not null check (revision > 0),
  authorization_hash text not null check (authorization_hash ~ '^0x[0-9a-f]{64}$'),
  policy_json jsonb not null check (jsonb_typeof(policy_json) = 'object' and octet_length(policy_json::text) <= 2048),
  deposit_cap_bps integer not null check (deposit_cap_bps between 0 and 1000),
  activation_block bigint not null check (activation_block >= 0),
  activation_block_hash text not null check (activation_block_hash ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key(wallet_id,revision), unique(wallet_id,authorization_hash)
);
create table private.gas_reserve_deposits (
  wallet_id uuid not null references private.gas_reserve_wallets(wallet_id) on delete restrict,
  transaction_hash text not null check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer not null check (log_index >= 0),
  block_number bigint not null check (block_number >= 0),
  block_hash text not null check (block_hash ~ '^0x[0-9a-f]{64}$'),
  sender text not null check (sender ~ '^0x[0-9a-f]{40}$'),
  amount_atomic numeric(78,0) not null check (amount_atomic > 0),
  revision bigint not null,
  eligible boolean not null,
  canonical boolean not null default true,
  created_at timestamptz not null default now(),
  primary key(wallet_id,transaction_hash,log_index),
  foreign key(wallet_id,revision) references private.gas_reserve_policies(wallet_id,revision)
);
create table private.gas_reserve_jobs (
  id uuid primary key,
  wallet_id uuid not null references private.gas_reserve_wallets(wallet_id) on delete restrict,
  revision bigint not null,
  state text not null check(state in ('reserved','dispatched','attention','settled','cancelled')),
  request_hash text not null check (request_hash ~ '^0x[0-9a-f]{64}$'),
  user_operation_hash text check (user_operation_hash ~ '^0x[0-9a-f]{64}$'),
  call_data_hash text not null check (call_data_hash ~ '^0x[0-9a-f]{64}$'),
  adapter_address text not null check (adapter_address ~ '^0x[0-9a-f]{40}$'),
  expected_output_wei numeric(78,0) not null check (expected_output_wei > 0),
  reserved_swap_atomic numeric(78,0) not null check (reserved_swap_atomic > 0),
  reserved_paymaster_atomic numeric(78,0) not null check (reserved_paymaster_atomic >= 0),
  native_prefund_wei numeric(78,0) not null check (native_prefund_wei > 0),
  valid_until bigint not null check(valid_until > 0),
  actual_swap_atomic numeric(78,0) not null default 0 check (actual_swap_atomic >= 0),
  actual_paymaster_atomic numeric(78,0) not null default 0 check (actual_paymaster_atomic >= 0),
  actual_native_fee_wei numeric(78,0) not null default 0 check (actual_native_fee_wei >= 0),
  residual_allowance_atomic numeric(78,0) not null default 0 check (residual_allowance_atomic >= 0),
  observed_allowance_atomic numeric(78,0) not null default 0 check (observed_allowance_atomic >= 0),
  receipt_json jsonb check (receipt_json is null or (jsonb_typeof(receipt_json)='object' and octet_length(receipt_json::text)<=4096)),
  receipt_hash text check (receipt_hash ~ '^0x[0-9a-f]{64}$'),
  receipt_block bigint,
  receipt_block_hash text check (receipt_block_hash ~ '^0x[0-9a-f]{64}$'),
  receipt_day date,
  allowance_release_block bigint,
  allowance_release_block_hash text check (allowance_release_block_hash ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(wallet_id,revision) references private.gas_reserve_policies(wallet_id,revision),
  check (state not in ('dispatched','settled') or user_operation_hash is not null),
  check (state <> 'settled' or (receipt_json is not null and receipt_hash is not null and receipt_day is not null))
);
create unique index gas_reserve_one_unresolved_job on private.gas_reserve_jobs(wallet_id)
  where state in ('reserved','dispatched','attention');
create unique index gas_reserve_unique_operation on private.gas_reserve_jobs(user_operation_hash)
  where user_operation_hash is not null;
create index gas_reserve_wallet_receipts on private.gas_reserve_jobs(wallet_id,receipt_day);

alter table private.gas_reserve_wallets enable row level security;
alter table private.gas_reserve_policies enable row level security;
alter table private.gas_reserve_deposits enable row level security;
alter table private.gas_reserve_jobs enable row level security;
revoke all on private.gas_reserve_wallets,private.gas_reserve_policies,
  private.gas_reserve_deposits,private.gas_reserve_jobs from public,anon,authenticated,service_role;

-- Deliberately no automatic grants to an existing EOA auto-funder. Enabling this
-- ledger requires the new verified AA execution service, not the old worker.
commit;
