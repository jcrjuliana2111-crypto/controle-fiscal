import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// SERPRO simulado (OAuth + gateway Integra Contador).
const chamadas = [];
const PDF = Buffer.from('%PDF-1.4\n' + 'x'.repeat(400)).toString('base64');
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = (s, o, h = {}) => { res.writeHead(s, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
    if (req.url === '/authenticate') {
      chamadas.push({ url: req.url, headers: req.headers, body });
      return json(200, { access_token: 'acc-123', jwt_token: 'jwt-456', expires_in: 2000, token_type: 'Bearer' });
    }
    const corpo = JSON.parse(body || '{}');
    chamadas.push({ url: req.url, headers: req.headers, corpo });
    const { idSistema, idServico, dados } = corpo.pedidoDados || {};
    const ok = (d) => json(200, { status: 200, dados: JSON.stringify(d), mensagens: [{ codigo: 'Sucesso-' + idSistema, texto: 'Requisição efetuada com sucesso.' }] });
    if (idServico === 'ENVIOXMLASSINADO81') return ok({ autenticar_procurador_token: 'tok-procurador', data_hora_expiracao: new Date(Date.now() + 3600e3).toISOString() });
    if (idServico === 'GERARDASPDF21') {
      if (corpo.contribuinte.numero === '00000000000191') return json(200, { status: 200, dados: '', mensagens: [{ codigo: 'Erro-PGMEI-MSG01', texto: 'Contribuinte não é MEI' }] });
      const pa = JSON.parse(dados).periodoApuracao;
      const venc = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
      return ok([{ cnpjCompleto: corpo.contribuinte.numero, pdf: PDF, detalhamento: [{ periodoApuracao: pa, numeroDocumento: '07202600000001', dataVencimento: venc, valores: { principal: 81.05, multa: 0, juros: 0, total: 81.05 }, codigoDeBarras: ['85800000000', '81050328262'] }] }]);
    }
    if (idServico === 'SOLICITARPROTOCOLO91') return ok({ protocoloRelatorio: 'PROTO-1', tempoEspera: 10 });
    if (idServico === 'RELATORIOSITFIS92') return ok({ pdf: PDF });
    if (idServico === 'CCMEISITCADASTRAL123') return ok([{ cnpj: corpo.contribuinte.numero, situacao: 'Enquadrado' }]);
    if (idServico === 'OBTERPROCURACAO41') return ok([{ dtexpiracao: '20271231', nrsistemas: 1, sistemas: ['PGMEI'] }]);
    json(200, { status: 200, dados: '{}', mensagens: [] });
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
process.env.INTEGRA_URL = `http://127.0.0.1:${mock.address().port}`;

const { prepararBanco, subirApp, encerrar, Cliente, novaConta } = await import('./_app.js');
const { certificadoTeste } = await import('./_cert.js');
const { caixaDeSaida } = await import('../src/saas/email.js');
const { verificarAssinatura } = await import('../src/core/assinatura.js');
const { rotinaDasMei } = await import('../src/integra/servico.js');
const { q, um } = await import('../src/db/pool.js');

let app, adm;
before(async () => {
  await prepararBanco();
  app = await subirApp();
  adm = new Cliente(app.url);
  await adm.post('/auth/cadastro', { nome: 'Juliana', email: 'admin@plataforma.com', senha: 'senha-admin-123', empresa: 'JCR Consultoria' });
  const tok = caixaDeSaida.filter((m) => m.to === 'admin@plataforma.com').pop().link.split('#verificar=')[1];
  await adm.post('/auth/verificar', { token: tok });
});
after(async () => { await app.fechar(); mock.close(); await encerrar(); });

const pfx = (doc) => certificadoTeste({ cnpj: doc }).toString('base64');
const contaId = async (email) => (await um(`SELECT m.conta_id FROM membros m JOIN usuarios u ON u.id = m.usuario_id WHERE u.email = $1`, [email])).conta_id;

test('trial: qualquer conta testa sem chaves; catálogo completo', async () => {
  const c = await novaConta(app.url, 'trial1');
  const cat = (await c.get('/fiscal/catalogo')).json;
  assert.ok(cat.length >= 85, `catálogo com ${cat.length} serviços`);
  assert.ok(cat.some((s) => s.codigo === 'PGMEI.GERARDASPDF21'));
  const r = await c.post('/fiscal/executar', { codigo: 'CCMEI.CCMEISITCADASTRAL123', contribuinte: '11.222.333/0001-81' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ambiente, 'trial');
  const ultima = chamadas.filter((x) => x.corpo).pop();
  assert.equal(ultima.url, '/Consultar');
  assert.equal(ultima.headers.authorization, 'Bearer 06aef429-a981-3ec5-a1f8-71d38d86481e');
  assert.equal((await c.post('/fiscal/executar', { codigo: 'PGMEI.GERARDASPDF21', contribuinte: '11222333000181', valores: { periodoApuracao: '13' } })).status, 422);
  assert.equal((await c.post('/fiscal/executar', { codigo: 'NAOEXISTE.X', contribuinte: '11222333000181' })).status, 422);
});

test('produção: configuração do contratante, OAuth, conta própria e cota do plano', async () => {
  assert.equal((await new Cliente(app.url).put('/admin/integra', {})).status, 401);
  const cfg = await adm.put('/admin/integra', { ambiente: 'producao', contratanteDocumento: '11222333000181', contratanteNome: 'JCR CONSULTORIA',
    consumerKey: 'ck', consumerSecret: 'cs', pfxBase64: pfx('11222333000181'), senha: '1234' });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.json.ambiente, 'producao');
  assert.ok(!JSON.stringify(cfg.json).includes('"cs"'), 'segredo não volta pela API');

  // Conta de outro escritório sem certificado de procurador: bloqueada (não pode usar as procurações da plataforma).
  const outro = await novaConta(app.url, 'escritorio2');
  const neg = await outro.post('/fiscal/executar', { codigo: 'PGMEI.GERARDASPDF21', contribuinte: '11222333000181', valores: { periodoApuracao: '202609' } });
  assert.equal(neg.status, 422);
  assert.match(neg.json.erro, /certificado e-CNPJ do seu escritório/);

  // Conta própria (marcada pelo administrador) usa o contratante como autor.
  const minha = await contaId('admin@plataforma.com');
  await adm.put(`/admin/contas/${minha}/integra`, { contaPropria: true });
  const r = await adm.post('/fiscal/executar', { codigo: 'PGMEI.GERARDASPDF21', contribuinte: '11.222.333/0001-81', valores: { periodoApuracao: '2026-09' } });
  assert.equal(r.status, 200);
  assert.ok(r.json.sucesso);
  assert.equal(r.json.documentos.length, 1);
  const auth = chamadas.find((x) => x.url === '/authenticate');
  assert.equal(auth.headers.authorization, 'Basic ' + Buffer.from('ck:cs').toString('base64'));
  assert.equal(auth.headers['role-type'], 'TERCEIROS');
  const env = chamadas.filter((x) => x.corpo).pop();
  assert.equal(env.url, '/Emitir');
  assert.equal(env.headers.jwt_token, 'jwt-456');
  assert.deepEqual(env.corpo.contratante, { numero: '11222333000181', tipo: 2 });
  assert.equal(env.corpo.pedidoDados.dados, '{"periodoApuracao":"202609"}');

  const pdf = await fetch(`${app.url}/api/v1/fiscal/documentos/${r.json.documentos[0].id}`, { headers: { Cookie: adm.cookie } });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  assert.equal((await outro.get(`/fiscal/documentos/${r.json.documentos[0].id}`)).status, 404, 'documento isolado por conta');

  const hist = (await adm.get('/fiscal/historico')).json;
  assert.equal(hist[0].codigo, 'PGMEI.GERARDASPDF21');
  assert.ok(!JSON.stringify(hist).includes(PDF), 'histórico não guarda o PDF em base64');
  const config = (await adm.get('/fiscal/config')).json;
  assert.equal(config.uso.emissao, 1);
  assert.equal(config.uso.custoEstimado, 0.32);

  // Cota do plano de teste (30/mês)
  await q(`INSERT INTO integra_chamadas (conta_id, contribuinte, codigo, tipo, categoria, ambiente, sucesso)
    SELECT $1, '11222333000181', 'X', 'Consultar', 'consulta', 'producao', true FROM generate_series(1, 29)`, [minha]);
  const lim = await adm.post('/fiscal/executar', { codigo: 'CCMEI.DADOSCCMEI122', contribuinte: '11222333000181' });
  assert.equal(lim.status, 402);
  await q(`DELETE FROM integra_chamadas WHERE codigo = 'X'`);

  const consumo = (await adm.get('/admin/integra')).json.consumo;
  assert.ok(consumo.find((x) => x.nome === 'JCR Consultoria').emissao >= 1);
});

test('procurador: termo assinado (perfil SERPRO) e token usado nas chamadas', async () => {
  const c = await novaConta(app.url, 'escritorio3', 'Contábil Três');
  const cert = certificadoTeste({ cnpj: '12345678000195' });
  const p = await c.put('/fiscal/procurador', { pfxBase64: cert.toString('base64'), senha: '1234', nome: 'CONTABIL TRES LTDA' });
  assert.equal(p.status, 200);
  assert.equal(p.json.documento, '12345678000195');

  const r = await c.post('/fiscal/executar', { codigo: 'CCMEI.CCMEISITCADASTRAL123', contribuinte: '11222333000181' });
  assert.equal(r.status, 200);
  const termo = chamadas.find((x) => x.corpo?.pedidoDados?.idServico === 'ENVIOXMLASSINADO81');
  assert.equal(termo.url, '/Apoiar');
  const xml = Buffer.from(JSON.parse(termo.corpo.pedidoDados.dados).xml, 'base64').toString();
  assert.match(xml, /<termoDeAutorizacao>/);
  assert.match(xml, /papel="contratante"/);
  assert.match(xml, /numero="12345678000195" nome="CONTABIL TRES LTDA" tipo="PJ" papel="autor pedido de dados"/);
  assert.match(xml, /<Reference URI="">/);
  assert.match(xml, /rsa-sha256/);
  assert.equal((xml.match(/<X509Certificate>/g) || []).length, 1);
  const { lerCertificado } = await import('../src/core/certificado.js');
  assert.ok(verificarAssinatura(xml, lerCertificado(cert, '1234').certPem), 'assinatura válida');

  const usada = chamadas.filter((x) => x.corpo?.pedidoDados?.idServico === 'CCMEISITCADASTRAL123').pop();
  assert.equal(usada.headers.autenticar_procurador_token, 'tok-procurador');
  assert.equal(usada.corpo.autorPedidoDados.numero, '12345678000195');

  // emissor não transmite declaração
  const n = chamadas.length;
  await c.post('/fiscal/executar', { codigo: 'CCMEI.DADOSCCMEI122', contribuinte: '11222333000181' });
  assert.equal(chamadas.slice(n).filter((x) => x.corpo?.pedidoDados?.idServico === 'ENVIOXMLASSINADO81').length, 0, 'token do procurador reaproveitado');
});

test('situação fiscal em duas etapas e procuração', async () => {
  const r = await adm.post('/fiscal/executar', { codigo: 'SITFIS.RELATORIOSITFIS92', contribuinte: '11222333000181' });
  assert.equal(r.status, 200);
  assert.equal(r.json.documentos.length, 1);
  const rel = chamadas.filter((x) => x.corpo?.pedidoDados?.idServico === 'RELATORIOSITFIS92').pop();
  assert.equal(rel.corpo.pedidoDados.dados, '{"protocoloRelatorio":"PROTO-1"}');
  const pr = await adm.post('/fiscal/executar', { codigo: 'PROCURACOES.OBTERPROCURACAO41', contribuinte: '11222333000181' });
  assert.equal(pr.status, 200);
  const env = chamadas.filter((x) => x.corpo?.pedidoDados?.idServico === 'OBTERPROCURACAO41').pop();
  assert.equal(JSON.parse(env.corpo.pedidoDados.dados).outorgado, '11222333000181');
});

test('DAS do MEI: carteira, geração com envio por e-mail, pago, rotina automática e lembrete', async () => {
  assert.equal((await adm.post('/fiscal/contribuintes', { documento: '123', nome: 'X' })).status, 422);
  const mei = (await adm.post('/fiscal/contribuintes', { documento: '11.222.333/0001-81', nome: 'Maria Doces MEI', email: 'maria@doces.com', regime: 'MEI' })).json;
  assert.equal((await adm.post('/fiscal/contribuintes', { documento: '11222333000181', nome: 'Duplicado' })).status, 409);
  const imp = (await adm.post('/fiscal/contribuintes/importar', { texto: '00000000000191;Banco Teste;;MEI\ninvalido;Fulano\n529.982.247-25;João PF;joao@x.com;PF' })).json;
  assert.equal(imp.criados, 2);
  assert.equal(imp.ignorados.length, 1);

  const antes = caixaDeSaida.length;
  const g = await adm.post('/fiscal/das-mei/gerar', { contribuinteId: mei.id, competencia: '202609' });
  assert.equal(g.status, 200);
  assert.equal(g.json.das.status, 'enviado');
  assert.equal(Number(g.json.das.valor), 81.05);
  const email = caixaDeSaida.slice(antes).find((m) => m.to === 'maria@doces.com');
  assert.ok(email);
  assert.match(email.subject, /DAS MEI 09\/2026/);
  assert.equal(email.attachments.length, 1);

  const lista = (await adm.get('/fiscal/das-mei?competencia=202609')).json;
  const banco = lista.itens.find((i) => i.documento === '00000000000191');
  const todos = (await adm.post('/fiscal/das-mei/gerar-todos', { competencia: '202609' })).json;
  assert.ok(todos.erros.some((e) => /não é MEI/.test(e.motivo)));
  assert.equal((await adm.get('/fiscal/das-mei?competencia=202609')).json.itens.find((i) => i.contribuinte_id === banco.contribuinte_id).status, 'erro');

  const das = lista.itens.find((i) => i.contribuinte_id === mei.id);
  assert.equal((await adm.put(`/fiscal/das-mei/${das.id}`, { pago: true })).status, 200);
  assert.equal((await adm.get('/fiscal/das-mei?competencia=202609')).json.itens.find((i) => i.contribuinte_id === mei.id).status, 'pago');

  // Rotina automática: gera a competência anterior a partir do dia configurado e lembra antes do vencimento
  const auto = (await adm.post('/fiscal/contribuintes', { documento: '12.ABC.345/01DE-35', nome: 'Auto MEI', email: 'auto@mei.com', regime: 'MEI', dasAutomatico: true })).json;
  const dia2 = new Date('2026-11-02T15:00:00Z');
  assert.equal((await rotinaDasMei(dia2)).gerados, 0, 'antes do dia configurado (5) não gera');
  const dia6 = new Date('2026-11-06T15:00:00Z');
  const r = await rotinaDasMei(dia6);
  assert.equal(r.gerados, 1);
  const gerado = await um(`SELECT * FROM das_mei WHERE contribuinte_id = $1 AND competencia = '202610'`, [auto.id]);
  assert.equal(gerado.status, 'enviado');
  assert.ok(r.lembretes >= 1, 'vencimento em 2 dias gera lembrete');
  assert.ok(caixaDeSaida.some((m) => m.to === 'auto@mei.com' && /Lembrete/.test(m.subject)));
  assert.equal((await rotinaDasMei(dia6)).gerados, 0, 'não gera de novo');
});
