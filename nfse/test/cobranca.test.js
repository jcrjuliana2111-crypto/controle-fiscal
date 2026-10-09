import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Asaas simulado: sobe antes de carregar a aplicação (a URL é lida na inicialização).
const chamadas = [];
let seq = 0;
const assinaturas = {};
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const corpo = body ? JSON.parse(body) : null;
    chamadas.push({ metodo: req.method, url: req.url, corpo, headers: req.headers });
    const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers.access_token !== 'chave-teste') return json(401, { errors: [{ description: 'Chave inválida' }] });
    if (!req.headers['user-agent']) return json(400, { errors: [{ description: 'User-Agent obrigatório' }] });
    if (req.method === 'POST' && req.url === '/v3/customers') return json(200, { id: `cus_${++seq}` });
    if (req.method === 'POST' && req.url === '/v3/subscriptions') {
      const id = `sub_${++seq}`;
      assinaturas[id] = { ...corpo, id };
      return json(200, assinaturas[id]);
    }
    let m;
    if ((m = req.url.match(/^\/v3\/subscriptions\/(sub_\d+)\/payments$/))) {
      return json(200, { data: [{ id: 'pay_1', value: assinaturas[m[1]]?.value, dueDate: '2026-10-09', status: 'PENDING', invoiceUrl: `https://sandbox.asaas.com/i/${m[1]}` }] });
    }
    if ((m = req.url.match(/^\/v3\/subscriptions\/(sub_\d+)$/))) {
      if (req.method === 'PUT') { Object.assign(assinaturas[m[1]], corpo); return json(200, assinaturas[m[1]]); }
      if (req.method === 'DELETE') return json(200, { deleted: true, id: m[1] });
    }
    json(404, { errors: [{ description: 'não simulado' }] });
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
process.env.ASAAS_API_KEY = 'chave-teste';
process.env.ASAAS_URL = `http://127.0.0.1:${mock.address().port}/v3`;
process.env.ASAAS_WEBHOOK_TOKEN = 'token-webhook-secreto';

const { prepararBanco, subirApp, encerrar, Cliente, novaConta } = await import('./_app.js');
const { verificarAssinaturas } = await import('../src/saas/cobranca.js');
const { q, um } = await import('../src/db/pool.js');

let app;
before(async () => { await prepararBanco(); app = await subirApp(); });
after(async () => { await app.fechar(); mock.close(); await encerrar(); });

const webhook = (corpo, token = 'token-webhook-secreto') => fetch(app.url + '/api/v1/cobranca/asaas', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'asaas-access-token': token }, body: JSON.stringify(corpo),
});
const prestador = { razaoSocial: 'Empresa Ltda', documento: '11222333000181', codigoMunicipio: '3304557' };
const contaDe = (email) => um(`SELECT c.* FROM contas c JOIN membros m ON m.conta_id = c.id JOIN usuarios u ON u.id = m.usuario_id WHERE u.email = $1`, [email]);

test('assinatura completa: assinar, pagar, trocar de plano, atrasar, suspender, reativar e cancelar', async () => {
  const c = await novaConta(app.url, 'cliente1', 'Cliente Um');
  assert.equal((await c.post('/assinatura', { plano: 'profissional' })).status, 422, 'exige CNPJ/CPF de faturamento');
  assert.equal((await c.put('/conta', { nome: 'Cliente Um', documento: '11.222.333/0001-81' })).status, 200);

  const r = await c.post('/assinatura', { plano: 'profissional' });
  assert.equal(r.status, 200);
  assert.match(r.json.urlPagamento, /^https:\/\/sandbox\.asaas\.com\/i\/sub_/);
  const criada = chamadas.find((x) => x.url === '/v3/subscriptions' && x.metodo === 'POST');
  assert.equal(criada.corpo.value, 149);
  assert.equal(criada.corpo.cycle, 'MONTHLY');
  assert.equal(criada.corpo.billingType, 'UNDEFINED');
  assert.equal(chamadas.find((x) => x.url === '/v3/customers').corpo.cpfCnpj, '11222333000181');

  let conta = await contaDe('cliente1@teste.com');
  assert.equal(conta.assinatura_status, 'aguardando_pagamento');
  assert.equal(conta.plano, 'teste', 'plano só muda depois do pagamento');
  const sub = conta.asaas_assinatura_id;

  assert.equal((await webhook({ id: 'evt_1', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1', subscription: sub, dueDate: '2026-10-09' } }, 'errado')).status, 401);
  const ok = await webhook({ id: 'evt_1', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1', subscription: sub, dueDate: '2026-10-09' } });
  assert.equal(ok.status, 200);
  conta = await contaDe('cliente1@teste.com');
  assert.equal(conta.plano, 'profissional');
  assert.equal(conta.assinatura_status, 'ativa');
  assert.ok(new Date(conta.pago_ate) > new Date('2026-11-08'));
  assert.equal((await (await webhook({ id: 'evt_1', event: 'PAYMENT_CONFIRMED', payment: { subscription: sub, dueDate: '2026-10-09' } })).json()).ignorado, true, 'evento repetido é ignorado');

  const fat = await c.get('/assinatura');
  assert.equal(fat.json.faturas[0].valor, 149);

  // Upgrade imediato
  const up = await c.post('/assinatura', { plano: 'escritorio' });
  assert.equal(up.json.mudou, true);
  const put = chamadas.filter((x) => x.metodo === 'PUT').pop();
  assert.equal(put.corpo.value, 399);
  assert.equal(put.corpo.updatePendingPayments, true);
  assert.equal((await contaDe('cliente1@teste.com')).plano, 'escritorio');

  // Downgrade bloqueado se exceder limites
  await c.post('/prestadores', prestador);
  await c.post('/prestadores', { ...prestador, codigoMunicipio: '3550308' });
  const down = await c.post('/assinatura', { plano: 'essencial' });
  assert.equal(down.status, 422);
  assert.match(down.json.erro, /excedente/);

  // Atraso -> suspensão após a tolerância -> pagamento reativa
  const venc = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);
  await webhook({ id: 'evt_2', event: 'PAYMENT_OVERDUE', payment: { subscription: sub, dueDate: venc } });
  assert.equal((await contaDe('cliente1@teste.com')).assinatura_status, 'atrasada');
  assert.equal((await c.get('/auth/eu')).json.conta.assinatura.status, 'atrasada');
  const v = await verificarAssinaturas();
  assert.equal(v.suspensas, 1);
  conta = await contaDe('cliente1@teste.com');
  assert.equal(conta.status, 'suspensa');
  assert.equal(conta.motivo_suspensao, 'inadimplencia');
  await webhook({ id: 'evt_3', event: 'PAYMENT_RECEIVED', payment: { subscription: sub, dueDate: venc } });
  conta = await contaDe('cliente1@teste.com');
  assert.equal(conta.status, 'ativa');
  assert.equal(conta.assinatura_status, 'ativa');

  // Cancelamento: mantém o plano até o fim do período pago
  assert.equal((await c.del('/assinatura')).status, 200);
  assert.ok(chamadas.some((x) => x.metodo === 'DELETE' && x.url === `/v3/subscriptions/${sub}`));
  assert.equal((await contaDe('cliente1@teste.com')).plano, 'escritorio');
  await verificarAssinaturas();
  assert.equal((await contaDe('cliente1@teste.com')).plano, 'escritorio', 'período pago ainda vale');
  await q(`UPDATE contas SET pago_ate = now() - interval '1 day' WHERE asaas_assinatura_id = $1`, [sub]);
  await verificarAssinaturas();
  conta = await contaDe('cliente1@teste.com');
  assert.equal(conta.plano, 'teste');
  assert.ok(new Date(conta.teste_ate) <= new Date(), 'teste já encerrado: produção bloqueada');
});

test('suspensão manual não é desfeita por pagamento; só o dono assina', async () => {
  const c = await novaConta(app.url, 'cliente2');
  await c.put('/conta', { nome: 'Cliente Dois', documento: '529.982.247-25' });
  await c.post('/assinatura', { plano: 'essencial' });
  const sub = (await contaDe('cliente2@teste.com')).asaas_assinatura_id;
  await q(`UPDATE contas SET status = 'suspensa', motivo_suspensao = 'manual' WHERE asaas_assinatura_id = $1`, [sub]);
  await webhook({ id: 'evt_10', event: 'PAYMENT_CONFIRMED', payment: { subscription: sub, dueDate: '2026-10-09' } });
  assert.equal((await contaDe('cliente2@teste.com')).status, 'suspensa');

  // emissor não pode assinar
  const outra = await novaConta(app.url, 'cliente3');
  await outra.post('/equipe/convites', { email: 'func3@teste.com', papel: 'admin' });
  const { caixaDeSaida } = await import('../src/saas/email.js');
  const token = caixaDeSaida.filter((m) => m.to === 'func3@teste.com').pop().link.split('#convite=')[1];
  const func = new Cliente(app.url);
  await func.post(`/auth/convite/${token}/aceitar`, { nome: 'Func', senha: 'senha-func-123' });
  assert.equal((await func.post('/assinatura', { plano: 'essencial' })).status, 403);
});

test('evento de assinatura desconhecida é aceito e ignorado', async () => {
  const r = await webhook({ id: 'evt_99', event: 'PAYMENT_CONFIRMED', payment: { subscription: 'sub_inexistente', dueDate: '2026-10-09' } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ignorado, true);
});
