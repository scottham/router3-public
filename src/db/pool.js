import pg from 'pg';
import { fromPostgresError } from '../lib/errors.js';

const { Pool } = pg;

export function createPool(config) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.DB_POOL_MAX,
    idleTimeoutMillis: config.DB_IDLE_TIMEOUT_MS,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    application_name: `${config.DB_APPLICATION_NAME}:${config.MCG_RUNTIME}`,
    ssl: config.databaseUrl.includes('sslmode=require')
      ? { rejectUnauthorized: config.DB_SSL_REJECT_UNAUTHORIZED }
      : undefined
  });
  pool.on('error', (error) => console.error(JSON.stringify({ level: 'error', message: 'postgres_pool_error', error: error.message })));
  return pool;
}

export async function withTransaction(pool, callback, { isolation = 'read committed', appUserId = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query(`begin isolation level ${isolation}`);
    if (appUserId) {
      await client.query("select set_config('request.app_user_id', $1, true)", [appUserId]);
    }
    const result = await callback(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw fromPostgresError(error);
  } finally {
    client.release();
  }
}

export async function queryOne(clientOrPool, text, values = []) {
  try {
    const result = await clientOrPool.query(text, values);
    return result.rows[0] ?? null;
  } catch (error) {
    throw fromPostgresError(error);
  }
}

export async function queryMany(clientOrPool, text, values = []) {
  try {
    const result = await clientOrPool.query(text, values);
    return result.rows;
  } catch (error) {
    throw fromPostgresError(error);
  }
}
