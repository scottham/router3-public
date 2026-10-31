begin;
-- Last answer of each provider's access probe (can this key call the model?).
-- The daily catalog run reuses it and probes only models without a fresh verdict.
create table private.catalog_model_access (
  provider text not null check (provider ~ '^[a-z0-9-]{1,40}$'),
  model text not null check (length(model) between 1 and 200),
  usable boolean not null,
  checked_at timestamptz not null default now(),
  primary key (provider,model)
);
revoke all on private.catalog_model_access from public,anon,authenticated;
commit;
