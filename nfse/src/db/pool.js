import pg from 'pg';
import { config } from '../config.js';

// bigint (numeração de RPS) volta como número; datas "date" como texto AAAA-MM-DD.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: Number(process.env.DB_POOL || 10) });

export function q(sql, params) {
  return pool.query(sql, params);
}

export async function um(sql, params) {
  return (await pool.query(sql, params)).rows[0] || null;
}

export async function varios(sql, params) {
  return (await pool.query(sql, params)).rows;
}

/** Executa fn(cliente) dentro de uma transação. */
export async function transacao(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
