begin;

-- The original bootstrap supported Supabase Auth. Base Account now owns the
-- complete application identity path, so disable the old trigger and browser
-- role grants while retaining auth_bindings only as migration history.
drop trigger if exists on_auth_user_created_model_gateway on auth.users;
drop function if exists private.handle_auth_user_created();
drop function if exists private.sync_auth_binding_last_seen();

create or replace function private.current_app_user_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, private
as $$
  select nullif(current_setting('request.app_user_id', true), '')::uuid
$$;

drop policy if exists app_users_select_self on public.app_users;
drop policy if exists profiles_select_self on public.user_profiles;
drop policy if exists profiles_update_self on public.user_profiles;
drop policy if exists wallets_select_self on public.user_wallets;

revoke select on public.app_users, public.user_profiles, public.user_wallets from anon, authenticated;
revoke update(display_name, avatar_url, locale, timezone) on public.user_profiles from anon, authenticated;
revoke execute on function private.current_app_user_id() from public, anon, authenticated, service_role;

commit;
