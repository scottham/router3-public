# Supabase PostgreSQL setup

[中文](SUPABASE_SETUP.zh.md)

Supabase supplies PostgreSQL, Studio, backups and migrations. `supabase/config.toml` disables Auth. Wallet signatures and backend SIWE sessions handle application login; publishable/service-role keys and OAuth providers are not needed.

## 1. Environments

Use separate development, staging and production projects. Record direct/pooler connections, project ref and backup/PITR policy. Application processes must use runtime-role connections, not the database owner.

## 2. Local database

```bash
npm run env:complete
npm run supabase:start
npm run db:configure-local
```

`env:complete` generates the session HMAC, encryption key, signer bearer token, Redis password and three runtime database passwords when absent, and writes host/Docker URLs. Unrecognized settings, provider credentials and existing usable values are preserved; it does not configure Supabase Auth.

`db:configure-local` applies the least-privilege role template with passwords from `.env`. Rerun it after each `supabase:reset`.

## 3. Remote migrations

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

Migrations run in filename order. Do not edit migrations already applied to shared environments; add a new migration. Do not add the `private` schema to Exposed Schemas.

## 4. Database roles

`npm run db:configure-local` fills `supabase/manual/create_backend_roles.sql.template` from `.env`. For manual use, replace every password placeholder with a separate strong password. Configure:

```text
DATABASE_URL_API
DATABASE_URL_SETTLER      # collector role
DATABASE_URL_RECONCILER
```

API, collector and reconciler have separate permissions for identity/session data, billing and recovery ([schema and grants](DATABASE_SCHEMA.md)). Signer/catalog roles are configured separately by `ops/bootstrap-production-db.mjs`. Historical indexer references in helper scripts are unused; no indexer service or connection is needed. Browsers never connect directly to Supabase.

## 5. Backup and recovery

Production needs PITR or backups meeting its RPO/RTO, regular restore drills, pre-migration snapshots, retained ledgers, minimal session/prompt/output storage and encryption of sensitive fields.
