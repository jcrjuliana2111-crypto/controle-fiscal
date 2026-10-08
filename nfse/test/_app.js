// Infra de teste: banco PostgreSQL limpo + servidor em porta aleatória + cliente com cookies.
process.env.DATABASE_URL ||= 'postgres://nfse:nfse@127.0.0.1:5432/nfse_test';
process.env.SUPERADMIN_EMAILS ||= 'admin@plataforma.com';

const { pool } = await import('../src/db/pool.js');
const { migrar } = await import('../src/db/migrar.js');
const { criarApp } = await import('../server.js');

export async function prepararBanco() {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await migrar({ log() {} });
}

export async function subirApp() {
  const srv = criarApp().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, fechar: () => new Promise((r) => srv.close(r)) };
}

export async function encerrar() {
  await pool.end();
}

export class Cliente {
  constructor(url) { this.url = url; this.cookie = ''; this.bearer = ''; }
  async req(metodo, caminho, corpo, headers = {}) {
    const r = await fetch(this.url + '/api/v1' + caminho, {
      method: metodo, redirect: 'manual',
      headers: {
        'Content-Type': 'application/json', 'X-Requested-With': 'fetch',
        ...(this.cookie ? { Cookie: this.cookie } : {}), ...(this.bearer ? { Authorization: 'Bearer ' + this.bearer } : {}), ...headers,
      },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const sc = r.headers.getSetCookie?.() || [];
    for (const c of sc) {
      const [par] = c.split(';');
      this.cookie = par.endsWith('=') ? '' : par;
    }
    const txt = await r.text();
    let json; try { json = JSON.parse(txt); } catch { json = txt; }
    return { status: r.status, json, headers: r.headers };
  }
  get(c, h) { return this.req('GET', c, undefined, h); }
  post(c, b, h) { return this.req('POST', c, b ?? {}, h); }
  put(c, b) { return this.req('PUT', c, b ?? {}); }
  del(c) { return this.req('DELETE', c); }
}

const { limparLimites } = await import('../src/saas/limitador.js');

export async function novaConta(url, sufixo, empresa = 'Empresa ' + sufixo) {
  limparLimites();
  const c = new Cliente(url);
  const r = await c.post('/auth/cadastro', { nome: 'Pessoa ' + sufixo, email: `${sufixo}@teste.com`, senha: 'senha-segura-123', empresa });
  if (r.status !== 201) throw new Error('cadastro falhou: ' + JSON.stringify(r.json));
  return c;
}
