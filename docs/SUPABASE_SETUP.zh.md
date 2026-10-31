# Supabase PostgreSQL 接入

[English](SUPABASE_SETUP.md)

Supabase 在本项目中只提供 PostgreSQL、Studio、备份和迁移。`supabase/config.toml` 明确关闭 Auth；应用登录由用户钱包签名 + 后端 SIWE 会话完成，不需要 Publishable Key、Service Role Key 或 OAuth Provider。

## 1. 环境

Development、Staging、Production 使用独立项目。需要记录数据库 Direct/Pooler 连接、Project Ref、备份/PITR 策略；不要把数据库 owner 连接交给应用进程。

## 2. 本地数据库

```bash
npm run env:complete
npm run supabase:start
npm run db:configure-local
```

`env:complete` 会补齐会话 HMAC、加密 Key、signer bearer token、Redis 密码和三个数据库角色密码，同时写入宿主机与 Docker 连接地址。已有可用值和未知配置（包括供应商凭据）会保留；脚本不配置 Supabase Auth。

`db:configure-local` 根据 `.env` 生成并执行最小权限角色 SQL。每次 `supabase:reset` 后都要重新执行。

## 3. 远程迁移

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

迁移按文件名顺序执行。已经在共享环境应用的迁移不要原地修改；用新迁移演进。`private` Schema 不应加入 Exposed Schemas。

## 4. 数据库角色

`npm run db:configure-local` 用 `.env` 里的密码执行 `supabase/manual/create_backend_roles.sql.template`；手动执行时替换其中的独立强密码。随后配置：

```text
DATABASE_URL_API
DATABASE_URL_SETTLER      # collector 使用
DATABASE_URL_RECONCILER
```

辅助脚本中的历史 indexer 引用已不使用，无需配置 indexer 服务或连接。API、collector、reconciler 各有自己的身份、账务与恢复权限，详见[数据库模型](DATABASE_SCHEMA.zh.md)。signer 和 catalog 的角色由 `ops/bootstrap-production-db.mjs` 单独创建。浏览器不直接连接 Supabase。

## 5. 备份与恢复

生产环境需要 PITR 或满足 RPO/RTO 的备份、定期恢复演练、迁移前快照、账本长期保留、会话/Prompt/Output 最小化存储和敏感字段加密。
