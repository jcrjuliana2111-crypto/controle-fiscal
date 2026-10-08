import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migracoes');

/** Aplica, em ordem, as migrações ainda não executadas. */
export async function migrar({ log = console.log } = {}) {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727274)'); // evita corrida entre instâncias
    await c.query(`CREATE TABLE IF NOT EXISTS _migracoes (nome text PRIMARY KEY, aplicada_em timestamptz NOT NULL DEFAULT now())`);
    const feitas = new Set((await c.query('SELECT nome FROM _migracoes')).rows.map((r) => r.nome));
    for (const arq of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (feitas.has(arq)) continue;
      await c.query('BEGIN');
      try {
        await c.query(fs.readFileSync(path.join(dir, arq), 'utf8'));
        await c.query('INSERT INTO _migracoes (nome) VALUES ($1)', [arq]);
        await c.query('COMMIT');
        log(`[db] migração aplicada: ${arq}`);
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`Falha na migração ${arq}: ${e.message}`);
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    c.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrar().then(() => pool.end()).catch((e) => { console.error(e.message); process.exit(1); });
}
