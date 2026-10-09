import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prepararBanco, subirApp, encerrar, Cliente, novaConta } from './_app.js';
import { certificadoTeste } from './_cert.js';
import { caixaDeSaida } from '../src/saas/email.js';
import { enviarAvisosVencimento } from '../src/saas/certificados.js';
import { q } from '../src/db/pool.js';
import { limparLimites } from '../src/saas/limitador.js';

let app;
before(async () => { await prepararBanco(); app = await subirApp(); });
after(async () => { await app.fechar(); await encerrar(); });

const emDias = (n) => new Date(Date.now() - 3 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
const publico = (slug, corpo) => fetch(`${app.url}/api/v1/publico/certificado/${slug}`, {
  method: corpo ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined,
});
const pedidoValido = { tipo: 'e-CNPJ A1', cnpj: '11.222.333/0001-81', razaoSocial: 'Padaria Bom Grão', nome: 'Maria Silva', cpf: '529.982.247-25',
  email: 'maria@bomgrao.com.br', telefone: '(41) 99999-0000', validacao: 'video', aceite: true };

test('carteira: cadastro manual, leitura do .pfx, empresa emitente sincronizada e isolamento', async () => {
  const c = await novaConta(app.url, 'contador1', 'Escritório Um');
  assert.equal((await c.post('/certificados', { titular: 'X' })).status, 422);
  const novo = await c.post('/certificados', { titular: 'Padaria Bom Grão', documento: '11222333000181', vencimento: emDias(20), clienteEmail: 'maria@bomgrao.com.br', avisarCliente: true });
  assert.equal(novo.status, 201);

  const lido = await c.post('/certificados/ler-pfx', { pfxBase64: certificadoTeste().toString('base64'), senha: '1234' });
  assert.equal(lido.json.documento, '11222333000181');
  assert.match(lido.json.vencimento, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await c.post('/certificados/ler-pfx', { pfxBase64: certificadoTeste().toString('base64'), senha: 'x' })).status, 422);

  const p = (await c.post('/prestadores', { razaoSocial: 'Emitente Ltda', documento: '11222333000181', codigoMunicipio: '3304557' })).json;
  await c.post(`/prestadores/${p.id}/certificado`, { pfxBase64: certificadoTeste().toString('base64'), senha: '1234' });
  const lista = (await c.get('/certificados')).json;
  assert.equal(lista.itens.length, 2);
  const daEmpresa = lista.itens.find((x) => x.prestadorId === p.id);
  assert.ok(daEmpresa, 'certificado instalado na empresa entra na carteira');
  assert.equal((await c.del(`/certificados/${daEmpresa.id}`)).status, 422, 'não remove o da empresa pela carteira');
  assert.equal(lista.resumo.ate30, 1);
  assert.equal((await c.get('/certificados?filtro=30')).json.itens.length, 1);

  const outro = await novaConta(app.url, 'contador2');
  assert.equal((await outro.get('/certificados')).json.itens.length, 0);
  assert.equal((await outro.put(`/certificados/${novo.json.id}`, { titular: 'Invasor', vencimento: emDias(5) })).status, 404);
});

test('avisos de vencimento: um por marco, sem duplicar, e aviso ao cliente com link de renovação', async () => {
  const c = await novaConta(app.url, 'contador3', 'Escritório Três');
  await c.get('/venda-certificados'); // gera o link público
  const cert = (await c.post('/certificados', { titular: 'Cliente Avisado', vencimento: emDias(10), clienteNome: 'João', clienteEmail: 'joao@cliente.com', avisarCliente: true })).json;
  await c.post('/certificados', { titular: 'Longe', vencimento: emDias(200) });
  const antes = caixaDeSaida.length;
  await enviarAvisosVencimento();
  const novos = caixaDeSaida.slice(antes);
  assert.ok(novos.some((m) => m.to === 'contador3@teste.com' && /Cliente Avisado vence em 10 dias/.test(m.subject)));
  const doCliente = novos.find((m) => m.to === 'joao@cliente.com');
  assert.ok(doCliente);
  assert.match(doCliente.link, /certificado\.html\?c=escritorio-tres&renovacao=1/);
  assert.ok(!novos.some((m) => /Longe/.test(m.subject)));

  const meio = caixaDeSaida.length;
  await enviarAvisosVencimento();
  assert.equal(caixaDeSaida.slice(meio).filter((m) => /Cliente Avisado/.test(m.subject)).length, 0, 'não repete o mesmo marco');

  await q(`UPDATE certificados SET vencimento = $2 WHERE id = $1`, [cert.id, emDias(1)]);
  await enviarAvisosVencimento();
  assert.ok(caixaDeSaida.slice(meio).some((m) => /vence amanhã/.test(m.subject)), 'novo marco (1 dia) gera novo aviso');

  // Renovou: vencimento novo zera os avisos
  await c.put(`/certificados/${cert.id}`, { ...cert, vencimento: emDias(365) });
  const r = await q('SELECT avisos_enviados FROM certificados WHERE id = $1', [cert.id]);
  assert.deepEqual(r.rows[0].avisos_enviados, []);
});

test('pedido público de certificado: validação, anti-robô, aviso ao vendedor e acompanhamento', async () => {
  limparLimites();
  const c = await novaConta(app.url, 'revenda', 'Revenda Certificados');
  const cfg = await c.put('/venda-certificados', { slug: 'revenda-teste', linkCompra: 'https://digibras.gfsis.com.br/loja', whatsapp: '(41) 98888-7777', mensagem: 'Atendimento em 24h', precos: { 'e-CNPJ A1': 199 } });
  assert.equal(cfg.status, 200);
  assert.match(cfg.json.link, /certificado\.html\?c=revenda-teste$/);

  const pag = await (await publico('revenda-teste')).json();
  assert.equal(pag.nome, 'Revenda Certificados');
  assert.equal(pag.precos['e-CNPJ A1'], 199);
  assert.equal((await publico('nao-existe')).status, 404);

  const ruim = await publico('revenda-teste', { ...pedidoValido, cpf: '111', aceite: false });
  assert.equal(ruim.status, 422);
  assert.equal((await publico('revenda-teste', { ...pedidoValido, site: 'http://spam' })).status, 422, 'campo-isca barra robôs');

  const ok = await publico('revenda-teste', pedidoValido);
  assert.equal(ok.status, 201);
  const res = await ok.json();
  assert.equal(res.linkCompra, 'https://digibras.gfsis.com.br/loja');
  assert.equal(res.whatsapp, '41988887777');
  assert.ok(caixaDeSaida.some((m) => m.to === 'revenda@teste.com' && /Novo pedido de certificado nº/.test(m.subject)));

  const pedidos = (await c.get('/pedidos-certificado')).json;
  assert.equal(pedidos.length, 1);
  assert.equal(pedidos[0].dados.cnpj, '11222333000181');
  assert.equal((await c.put(`/pedidos-certificado/${pedidos[0].id}`, { status: 'emitido' })).status, 200);
  assert.equal((await c.get('/pedidos-certificado?status=emitido')).json.length, 1);

  const outra = await novaConta(app.url, 'outrarevenda');
  assert.equal((await outra.get('/pedidos-certificado')).json.length, 0);
  assert.equal((await outra.put(`/pedidos-certificado/${pedidos[0].id}`, { status: 'cancelado' })).status, 404);
  assert.equal((await outra.put('/venda-certificados', { slug: 'revenda-teste' })).status, 409, 'endereço único');

  await c.put('/venda-certificados', { ativo: false });
  assert.equal((await publico('revenda-teste')).status, 404, 'página desativada');
});
