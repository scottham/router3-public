begin;
alter table private.model_price_versions add column bailian_quote jsonb;
create table private.bailian_catalog_state (
  model_id uuid primary key references public.model_catalog(id),
  synced_at timestamptz not null,
  source_region text not null,
  offline_at timestamptz
);
revoke all on private.bailian_catalog_state from public,anon,authenticated;
commit;
