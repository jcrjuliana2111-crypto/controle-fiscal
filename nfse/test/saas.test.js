import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { prepararBanco, subirApp, encerrar, Cliente, novaConta } from './_app.js';
import { certificadoTeste } from './_cert.js';
import { caixaDeSaida } from '../src/saas/email.js';
import { URLS } from '../src/providers/nacional.js';
import { processarFila } from '../src/saas/webhooks.js';
import { limparLimites } from '../src/saas/limitador.js';

let app, mock, mockUrl;
const chamadasSefin = [];
const webhooksRecebidos = [];
const pfx = certificadoTeste().toString('base64');
const CHAVE = '33045572112223330001810000000000000126100000000123';
let contadorNfse = 0;

before(async () => {
  await prepararBanco();
  app = await subirApp();
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/hook') { webhooksRecebidos.push({ headers: req.headers, body }); return json(200, {}); }
      chamadasSefin.push({ metodo: req.method, url: req.url, body });
      if (req.method === 'POST' && req.url === '/sefin/nfse') {
        const dps = gunzipSync(Buffer.from(JSON.parse(body).dpsXmlGZipB64, 'base64')).toString();
        if (dps.includes('<vServ>666.00</vServ>')) return json(400, { erros: [{ Codigo: 'E0712', Descricao: 'cTribNac inexistente' }] });
        const n = ++contadorNfse;
        const chave = CHAVE.slice(0, -3) + String(n).padStart(3, '0');
        const nfse = `<NFSe><infNFSe Id="NFS${chave}"><nNFSe>${n}</nNFSe><cStat>100</cStat></infNFSe></NFSe>`;
        return json(201, { chaveAcesso: chave, nfseXmlGZipB64: gzipSync(nfse).toString('base64') });
      }
      if (req.method === 'POST' && /\/sefin\/nfse\/\d+\/eventos$/.test(req.url)) return json(201, { eventoXmlGZipB64: gzipSync('<ok/>').toString('base64') });
      json(404, {});
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  mockUrl = `http://127.0.0.1:${mock.address().port}`;
  URLS.homologacao.sefin = mockUrl + '/sefin';
  URLS.producao.sefin = mockUrl + '/sefin';
});

after(async () => {
  await app.fechar();
  mock.close();
  await encerrar();
});

const prestadorBase = { razaoSocial: 'Empresa Teste Ltda', documento: '11.222.333/0001-81', codigoMunicipio: '3304557', municipio: 'Rio de Janeiro', uf: 'RJ', inscricaoMunicipal: '123' };
const nota = (prestadorId, valor = 1000) => ({
  prestadorId, competencia: '2026-10-01',
  tomador: { tipo: 'PF', documento: '529.982.247-25', nome: 'Fulano de Tal' },
  servico: { codigoTributacaoNacional: '010701', discriminacao: 'Desenvolvimento de sistema' },
  valores: { servico: valor, aliquotaIss: 3 },
});

test('cadastro, login, sessão e logout', async () => {
  const c = await novaConta(app.url, 'ana', 'Escritório da Ana');
  const eu = await c.get('/auth/eu');
  assert.equal(eu.status, 200);
  assert.equal(eu.json.usuario.email, 'ana@teste.com');
  assert.equal(eu.json.papel, 'dono');
  assert.equal(eu.json.conta.plano, 'teste');
  assert.equal(eu.json.conta.nome, 'Escritório da Ana');
  assert.ok(caixaDeSaida.some((m) => m.to === 'ana@teste.com' && /Confirme/.test(m.subject)));

  const dup = await new Cliente(app.url).post('/auth/cadastro', { nome: 'X', email: 'ANA@teste.com', senha: 'outrasenha1', empresa: 'X' });
  assert.equal(dup.status, 409, 'e-mail é único sem diferenciar maiúsculas');
  assert.equal((await new Cliente(app.url).post('/auth/cadastro', { nome: 'X', email: 'x@x.com', senha: '123', empresa: 'X' })).status, 422);

  await c.post('/auth/sair');
  assert.equal((await c.get('/auth/eu')).status, 401);
  assert.equal((await c.post('/auth/entrar', { email: 'ana@teste.com', senha: 'errada' })).status, 401);
  assert.equal((await c.post('/auth/entrar', { email: 'ana@teste.com', senha: 'senha-segura-123' })).status, 200);
  assert.equal((await c.get('/auth/eu')).status, 200);
});

test('proteção CSRF em requisições com cookie', async () => {
  const c = await novaConta(app.url, 'csrf');
  const r = await c.req('POST', '/prestadores', prestadorBase, { 'X-Requested-With': '' });
  assert.equal(r.status, 403);
});

test('isolamento entre contas (multiempresa)', async () => {
  const a = await novaConta(app.url, 'isoa');
  const b = await novaConta(app.url, 'isob');
  const p = await a.post('/prestadores', prestadorBase);
  assert.equal(p.status, 201);
  assert.equal(p.json.certificado, null);
  assert.deepEqual((await b.get('/prestadores')).json, []);
  assert.equal((await b.get(`/prestadores/${p.json.id}`)).status, 404);
  assert.equal((await b.put(`/prestadores/${p.json.id}`, { razaoSocial: 'Invasor' })).status, 404);
  assert.equal((await b.post('/notas/previsualizar', nota(p.json.id))).status, 404);
  // a mesma empresa pode ser cadastrada em contas diferentes (ex.: dois escritórios)
  assert.equal((await b.post('/prestadores', prestadorBase)).status, 201);
  assert.equal((await a.post('/prestadores', prestadorBase)).status, 409);
});

test('equipe: convite, papéis e permissões', async () => {
  const dono = await novaConta(app.url, 'dono1');
  const p = (await dono.post('/prestadores', prestadorBase)).json;
  const conv = await dono.post('/equipe/convites', { email: 'emissor1@teste.com', papel: 'emissor' });
  assert.equal(conv.status, 201);
  const token = caixaDeSaida.filter((m) => m.to === 'emissor1@teste.com').pop().link.split('#convite=')[1];

  const info = await new Cliente(app.url).get(`/auth/convite/${token}`);
  assert.equal(info.json.papel, 'emissor');
  const emissor = new Cliente(app.url);
  assert.equal((await emissor.post(`/auth/convite/${token}/aceitar`, { nome: 'Emissor', senha: 'senha-emissor-1' })).status, 200);
  assert.equal((await emissor.post(`/auth/convite/${token}/aceitar`, { nome: 'Emissor', senha: 'senha-emissor-1' })).status, 422, 'convite só vale uma vez');

  const eu = (await emissor.get('/auth/eu')).json;
  assert.equal(eu.papel, 'emissor');
  assert.equal((await emissor.get('/prestadores')).json.length, 1);
  assert.equal((await emissor.post('/prestadores', { ...prestadorBase, codigoMunicipio: '3550308' })).status, 403);
  assert.equal((await emissor.post('/equipe/convites', { email: 'z@z.com', papel: 'admin' })).status, 403);
  assert.equal((await emissor.put(`/prestadores/${p.id}`, { ambiente: 'producao' })).status, 403);

  // plano de teste permite 2 usuários
  assert.equal((await dono.post('/equipe/convites', { email: 'terceiro@teste.com', papel: 'leitura' })).status, 402);

  const equipe = (await dono.get('/equipe')).json;
  assert.equal(equipe.membros.length, 2);
  const idEmissor = equipe.membros.find((m) => m.email === 'emissor1@teste.com').id;
  assert.equal((await dono.put(`/equipe/${idEmissor}`, { papel: 'leitura' })).status, 200);
  assert.equal((await emissor.post('/notas/previsualizar', nota(p.id))).status, 403, 'leitura não emite');
  assert.equal((await dono.del(`/equipe/${idEmissor}`)).status, 204);
  assert.equal((await emissor.get('/prestadores')).status, 403);
});

test('redefinição de senha', async () => {
  const c = await novaConta(app.url, 'esqueci');
  await c.post('/auth/sair');
  const r = await new Cliente(app.url).post('/auth/esqueci', { email: 'esqueci@teste.com' });
  assert.equal(r.status, 200);
  assert.equal((await new Cliente(app.url).post('/auth/esqueci', { email: 'naoexiste@teste.com' })).status, 200, 'não revela cadastros');
  const token = caixaDeSaida.filter((m) => m.to === 'esqueci@teste.com' && /Redefini/.test(m.subject)).pop().link.split('#redefinir=')[1];
  const nova = new Cliente(app.url);
  assert.equal((await nova.post('/auth/redefinir', { token, senha: 'nova-senha-456' })).status, 200);
  assert.equal((await nova.post('/auth/redefinir', { token, senha: 'outra-senha-789' })).status, 422);
  assert.equal((await new Cliente(app.url).post('/auth/entrar', { email: 'esqueci@teste.com', senha: 'nova-senha-456' })).status, 200);
});

test('limite de tentativas de login', async () => {
  limparLimites();
  const c = new Cliente(app.url);
  let ultimo;
  for (let i = 0; i < 9; i++) ultimo = await c.post('/auth/entrar', { email: 'alvo@teste.com', senha: 'x' });
  assert.equal(ultimo.status, 429);
  limparLimites();
});

test('limites do plano e administração da plataforma', async () => {
  const c = await novaConta(app.url, 'limite');
  assert.equal((await c.post('/prestadores', prestadorBase)).status, 201);
  assert.equal((await c.post('/prestadores', { ...prestadorBase, codigoMunicipio: '3550308' })).status, 201);
  const r = await c.post('/prestadores', { ...prestadorBase, codigoMunicipio: '4106902' });
  assert.equal(r.status, 402);
  assert.match(r.json.erro, /upgrade/);

  assert.equal((await c.get('/admin/contas')).status, 403);
  const admin = await novaConta(app.url, 'admin', 'Plataforma');
  // SUPERADMIN_EMAILS=admin@plataforma.com
  const adm = new Cliente(app.url);
  await adm.post('/auth/cadastro', { nome: 'Admin', email: 'admin@plataforma.com', senha: 'senha-admin-123', empresa: 'Plataforma' });
  assert.equal((await admin.get('/admin/contas')).status, 403);
  assert.equal((await adm.get('/admin/contas')).status, 403, 'e-mail da lista ainda não confirmado não vira superadmin');
  const tokenVerif = caixaDeSaida.filter((m) => m.to === 'admin@plataforma.com').pop().link.split('#verificar=')[1];
  assert.equal((await adm.post('/auth/verificar', { token: tokenVerif })).status, 200);
  const contas = (await adm.get('/admin/contas')).json;
  const alvo = contas.find((x) => x.dono === 'limite@teste.com');
  assert.equal((await adm.put(`/admin/contas/${alvo.id}`, { plano: 'escritorio' })).status, 200);
  assert.equal((await c.post('/prestadores', { ...prestadorBase, codigoMunicipio: '4106902' })).status, 201);
  assert.equal((await adm.put(`/admin/contas/${alvo.id}`, { plano: 'inexistente' })).status, 422);
});

test('chaves de API', async () => {
  const c = await novaConta(app.url, 'api');
  const p = (await c.post('/prestadores', prestadorBase)).json;
  const k = await c.post('/chaves', { nome: 'ERP', papel: 'emissor' });
  assert.equal(k.status, 201);
  assert.match(k.json.token, /^nfk_/);
  assert.ok(!JSON.stringify((await c.get('/chaves')).json).includes(k.json.token), 'token não é listado de novo');

  const api = new Cliente(app.url);
  api.bearer = k.json.token;
  const lista = await api.req('GET', '/prestadores', undefined, { 'X-Requested-With': '' });
  assert.equal(lista.status, 200);
  assert.equal(lista.json[0].id, p.id);
  assert.equal((await api.post('/prestadores', prestadorBase)).status, 403, 'chave de emissor não cadastra prestador');

  await c.del(`/chaves/${k.json.id}`);
  assert.equal((await api.get('/prestadores')).status, 401);
  api.bearer = 'nfk_invalida';
  assert.equal((await api.get('/prestadores')).status, 401);
});

test('emissão: autorização, rejeição, idempotência, concorrência, cancelamento e webhooks', async () => {
  const c = await novaConta(app.url, 'emite');
  const p = (await c.post('/prestadores', prestadorBase)).json;
  assert.equal((await c.post('/notas', nota(p.id))).status, 422, 'exige certificado');

  const cert = await c.post(`/prestadores/${p.id}/certificado`, { pfxBase64: pfx, senha: '1234' });
  assert.equal(cert.status, 200);
  assert.equal(cert.json.certificado.documento, '11222333000181');
  assert.equal(JSON.stringify(cert.json).includes('cert_pfx'), false);
  assert.equal((await c.post(`/prestadores/${p.id}/certificado`, { pfxBase64: pfx, senha: 'errada' })).status, 422);

  const wh = await c.post('/webhooks', { url: mockUrl + '/hook' });
  assert.equal(wh.status, 201);
  const segredo = wh.json.segredo;

  const prev = await c.post('/notas/previsualizar', nota(p.id));
  assert.ok(prev.json.assinado);

  const rej = await c.post('/notas', nota(p.id, 666));
  assert.equal(rej.json.status, 'rejeitada');
  assert.equal(rej.json.mensagens[0].codigo, 'E0712');
  assert.equal((await c.get(`/prestadores/${p.id}`)).json.proximoNumero, 1, 'rejeição devolve o número');

  const ok = await c.post('/notas', nota(p.id), { 'Idempotency-Key': 'pedido-123' });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.status, 'autorizada');
  assert.equal(ok.json.numeroRps, 1);
  const rep = await c.post('/notas', nota(p.id), { 'Idempotency-Key': 'pedido-123' });
  assert.equal(rep.status, 200);
  assert.equal(rep.json.id, ok.json.id, 'mesma chave de idempotência devolve a mesma nota');

  const lote = await Promise.all([1, 2, 3, 4].map(() => c.post('/notas', nota(p.id))));
  assert.deepEqual(lote.map((x) => x.json.numeroRps).sort(), [2, 3, 4, 5]);

  const lista = await c.get('/notas?status=autorizada&busca=fulano');
  assert.equal(lista.json.total, 5);
  assert.equal((await c.get(`/notas/${ok.json.id}/xml`)).status, 200);
  const ev = await c.get(`/notas/${ok.json.id}/eventos`);
  assert.equal(ev.json[0].tipo, 'emissao');

  const canc = await c.post(`/notas/${ok.json.id}/cancelar`, { codigo: 1, motivo: 'Erro no valor do servico informado' });
  assert.ok(canc.json.sucesso);
  assert.equal(canc.json.nota.status, 'cancelada');

  await processarFila();
  await new Promise((r) => setTimeout(r, 200));
  await processarFila();
  const eventos = webhooksRecebidos.map((w) => JSON.parse(w.body).evento);
  assert.ok(eventos.includes('nota.autorizada'));
  assert.ok(eventos.includes('nota.rejeitada'));
  assert.ok(eventos.includes('nota.cancelada'));
  const w = webhooksRecebidos[0];
  const [, t, v1] = w.headers['x-assinatura'].match(/t=(\d+),v1=([0-9a-f]+)/);
  assert.equal(crypto.createHmac('sha256', segredo).update(`${t}.${w.body}`).digest('hex'), v1, 'assinatura HMAC confere');

  const painel = await c.get('/painel');
  assert.equal(painel.status, 200);
  const csv = await c.get('/notas.csv');
  assert.match(csv.json, /Fulano de Tal/);
});

test('produção bloqueada após o fim do teste grátis', async () => {
  const c = await novaConta(app.url, 'expira');
  const p = (await c.post('/prestadores', prestadorBase)).json;
  await c.post(`/prestadores/${p.id}/certificado`, { pfxBase64: pfx, senha: '1234' });
  assert.equal((await c.put(`/prestadores/${p.id}`, { ambiente: 'producao' })).status, 200);
  assert.equal((await c.post('/notas', nota(p.id))).json.status, 'autorizada');

  const adm = new Cliente(app.url);
  await adm.post('/auth/entrar', { email: 'admin@plataforma.com', senha: 'senha-admin-123' });
  const alvo = (await adm.get('/admin/contas')).json.find((x) => x.dono === 'expira@teste.com');
  await adm.put(`/admin/contas/${alvo.id}`, { testeAte: '2020-01-01T00:00:00Z' });
  const r = await c.post('/notas', nota(p.id));
  assert.equal(r.status, 402);
  assert.match(r.json.erro, /teste terminou/);

  await adm.put(`/admin/contas/${alvo.id}`, { plano: 'essencial' });
  assert.equal((await c.post('/notas', nota(p.id))).json.status, 'autorizada');
  await adm.put(`/admin/contas/${alvo.id}`, { status: 'suspensa' });
  assert.equal((await c.post('/notas', nota(p.id))).status, 403);
});
