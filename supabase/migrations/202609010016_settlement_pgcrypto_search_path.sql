begin;

-- Supabase installs pgcrypto in the extensions schema. The settlement planner
-- deliberately uses a restricted SECURITY DEFINER search path, so make that
-- dependency explicit without exposing any user-writable schema.
alter function private.plan_settlement_batch(uuid, numeric)
  set search_path = pg_catalog, private, extensions;

commit;
