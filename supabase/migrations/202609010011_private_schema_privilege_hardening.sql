begin;

-- PostgreSQL grants EXECUTE on new functions to PUBLIC unless told otherwise.
-- The application now reaches private objects only through explicitly granted
-- backend roles; Supabase browser roles and PUBLIC receive no private surface.
revoke usage on schema private from anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

-- Revoke only the public objects exposed to Supabase Auth in earlier releases.
revoke select on public.app_users, public.user_profiles, public.user_wallets,
  public.organizations, public.organization_members, public.projects,
  public.model_catalog from anon, authenticated;
revoke update(display_name, avatar_url, locale, timezone)
  on public.user_profiles from anon, authenticated;
revoke execute on function public.create_organization(text,text) from public, anon, authenticated;
revoke execute on function public.create_project(uuid,text,text,bigint,bigint,bigint,bigint,uuid[])
  from public, anon, authenticated;
revoke execute on function public.get_my_billing_summaries() from public, anon, authenticated;

alter default privileges in schema private revoke all on tables from public, anon, authenticated;
alter default privileges in schema private revoke all on sequences from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public, anon, authenticated;

commit;
