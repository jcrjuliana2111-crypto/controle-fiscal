import express from 'express';
import * as contas from '../saas/contas.js';
import * as notas from '../core/notas.js';
import * as prest from '../core/prestadores.js';
import * as mun from '../core/municipios.js';
import * as wh from '../saas/webhooks.js';
import { auditar, listarAuditoria } from '../saas/auditoria.js';
import { limitar } from '../saas/limitador.js';
import { invalido, ErroApp } from '../saas/erros.js';
import { PROVEDORES, PRESETS } from '../providers/index.js';
import { MOTIVOS_CANCELAMENTO } from '../providers/nacional.js';
import { planosPublicos } from '../saas/planos.js';
import { calcular } from '../core/calculo.js';
import { espelhoHtml } from '../espelho.js';
import { h, exigir, exigirConta } from './middleware.js';
import { config } from '../config.js';
import * as cobranca from '../saas/cobranca.js';
import * as certs from '../saas/certificados.js';
import * as fiscal from '../integra/servico.js';
import { servico as servicoIntegra } from '../integra/catalogo.js';
import { pode } from '../saas/planos.js';
import { limitar as limitarIp } from '../saas/limitador.js';

const r = express.Router();

// ------------------------------------------------------------ público
r.get('/info', (req, res) => res.json({
  provedores: Object.values(PROVEDORES).map((p) => ({ id: p.id, nome: p.nome })),
  presetsAbrasf: Object.entries(PRESETS).map(([id, p]) => ({ id, nome: p.nome })),
  motivosCancelamento: MOTIVOS_CANCELAMENTO,
  planos: planosPublicos(),
  suporte: config.emailSuporte || null,
}));
r.post('/calcular', (req, res) => res.json(calcular(req.body || {})));

// Webhook do Asaas (público; autenticado pelo token configurado no painel do Asaas).
r.post('/cobranca/asaas', h(async (req, res) => {
  if (!cobranca.tokenWebhookValido(req.get('asaas-access-token'))) throw new ErroApp(401, 'Token do webhook inválido.');
  const r2 = await cobranca.processarEvento(req.body || {});
  res.json({ ok: true, ...r2 });
}));

// Página pública de pedido de certificado (link divulgado pela conta).
r.get('/publico/certificado/:slug', h(async (req, res) => res.json(await certs.paginaPublica(req.params.slug))));
r.post('/publico/certificado/:slug', h(async (req, res) => {
  limitarIp(`pedido-cert:${req.ip}`, { max: 10, janelaMs: 3600_000 });
  res.status(201).json(await certs.criarPedido(req.params.slug, req.body || {}, req.ip));
}));

// Daqui em diante, tudo exige estar autenticado numa conta.
r.use(exigirConta);

// ------------------------------------------------------------ fiscal (Integra Contador)
r.get('/fiscal/catalogo', exigir('ver'), (req, res) => res.json(fiscal.catalogoPublico()));
r.get('/fiscal/config', exigir('ver'), h(async (req, res) => {
  const [plat, proc, uso, sit] = await Promise.all([fiscal.configPublica(), fiscal.procuradorDaConta(req.quem.contaId), fiscal.usoDoMes(req.quem.contaId), contas.situacaoConta(req.quem.contaId)]);
  res.json({ ambiente: plat.ambiente, contratante: plat.contratante, procurador: proc, uso, limite: sit.limites.fiscalMes ?? 0 });
}));
r.put('/fiscal/procurador', exigir('prestadores'), express.json({ limit: '2mb' }), h(async (req, res) => {
  const p = await fiscal.salvarProcurador(req.quem.contaId, req.body || {});
  await auditar(req.quem, 'integra.procurador', req.quem.contaId);
  res.json(p);
}));
r.get('/fiscal/contribuintes', exigir('ver'), h(async (req, res) => res.json(await fiscal.listarContribuintes(req.quem.contaId, req.query))));
r.post('/fiscal/contribuintes', exigir('emitir'), h(async (req, res) => res.status(201).json(await fiscal.salvarContribuinte(req.quem.contaId, req.body || {}))));
r.post('/fiscal/contribuintes/importar', exigir('emitir'), h(async (req, res) => res.json(await fiscal.importarContribuintes(req.quem.contaId, req.body?.texto))));
r.put('/fiscal/contribuintes/:id', exigir('emitir'), h(async (req, res) => res.json(await fiscal.salvarContribuinte(req.quem.contaId, { ...req.body, id: req.params.id }))));
r.delete('/fiscal/contribuintes/:id', exigir('emitir'), h(async (req, res) => { await fiscal.removerContribuinte(req.quem.contaId, req.params.id); res.status(204).end(); }));
r.post('/fiscal/executar', exigir('emitir'), h(async (req, res) => {
  const s = servicoIntegra(req.body?.codigo);
  if (s?.tipo === 'Declarar' && !pode(req.quem.papel, 'prestadores')) throw new ErroApp(403, 'Transmitir declarações exige perfil de administrador.');
  limitar(`fiscal:${req.quem.contaId}`, { max: 60, janelaMs: 60_000 });
  res.json(await fiscal.executar(req.quem, { ...req.body, origem: req.quem.viaApi ? 'api' : 'manual' }));
}));
r.get('/fiscal/historico', exigir('ver'), h(async (req, res) => res.json(await fiscal.historico(req.quem.contaId, req.query))));
r.get('/fiscal/historico/:id', exigir('ver'), h(async (req, res) => res.json(await fiscal.respostaDaChamada(req.quem.contaId, req.params.id))));
r.get('/fiscal/documentos/:id', exigir('ver'), h(async (req, res) => {
  const d = await fiscal.documento(req.quem.contaId, req.params.id);
  res.type('application/pdf').set('Content-Disposition', `${req.query.baixar ? 'attachment' : 'inline'}; filename="${d.nome_arquivo}"`).send(d.conteudo);
}));
r.get('/fiscal/das-mei', exigir('ver'), h(async (req, res) => res.json(await fiscal.listarDasMei(req.quem.contaId, req.query.competencia))));
r.post('/fiscal/das-mei/gerar', exigir('emitir'), h(async (req, res) =>
  res.json(await fiscal.gerarDasMei(req.quem, req.body?.contribuinteId, req.body?.competencia, { enviar: req.body?.enviar !== false }))));
r.post('/fiscal/das-mei/gerar-todos', exigir('emitir'), h(async (req, res) => {
  const { itens, competencia } = await fiscal.listarDasMei(req.quem.contaId, req.body?.competencia);
  const resultado = { gerados: 0, erros: [] };
  for (const i of itens.filter((x) => x.status !== 'pago')) {
    try {
      const r2 = await fiscal.gerarDasMei(req.quem, i.contribuinte_id, competencia, { enviar: req.body?.enviar !== false });
      r2.sucesso ? resultado.gerados++ : resultado.erros.push({ nome: i.nome, motivo: r2.mensagens.map((m) => m.texto).join(' ') });
    } catch (e) { resultado.erros.push({ nome: i.nome, motivo: e.message }); }
  }
  res.json(resultado);
}));
r.post('/fiscal/das-mei/:id/enviar', exigir('emitir'), h(async (req, res) => { await fiscal.enviarDas(req.quem.contaId, req.params.id); res.json({ ok: true }); }));
r.put('/fiscal/das-mei/:id', exigir('emitir'), h(async (req, res) => { await fiscal.marcarDasPago(req.quem.contaId, req.params.id, req.body?.pago); res.json({ ok: true }); }));

// ------------------------------------------------------------ certificados
r.get('/certificados', exigir('ver'), h(async (req, res) => res.json({
  itens: await certs.listarCertificados(req.quem.contaId, req.query), resumo: await certs.resumoCertificados(req.quem.contaId), tipos: certs.TIPOS,
})));
r.post('/certificados', exigir('prestadores'), h(async (req, res) => res.status(201).json(await certs.salvarCertificado(req.quem.contaId, req.body || {}))));
r.put('/certificados/:id', exigir('prestadores'), h(async (req, res) => res.json(await certs.salvarCertificado(req.quem.contaId, { ...req.body, id: req.params.id }))));
r.delete('/certificados/:id', exigir('prestadores'), h(async (req, res) => { await certs.removerCertificado(req.quem.contaId, req.params.id); res.status(204).end(); }));
r.post('/certificados/ler-pfx', exigir('prestadores'), express.json({ limit: '2mb' }), h(async (req, res) =>
  res.json(certs.lerDadosPfx(Buffer.from(req.body?.pfxBase64 || '', 'base64'), req.body?.senha || ''))));
r.get('/venda-certificados', exigir('ver'), h(async (req, res) => res.json(await certs.configVenda(req.quem.contaId))));
r.put('/venda-certificados', exigir('prestadores'), h(async (req, res) => res.json(await certs.salvarConfigVenda(req.quem.contaId, req.body || {}))));
r.get('/pedidos-certificado', exigir('ver'), h(async (req, res) => res.json(await certs.listarPedidos(req.quem.contaId, req.query))));
r.put('/pedidos-certificado/:id', exigir('prestadores'), h(async (req, res) => {
  await certs.alterarPedido(req.quem.contaId, req.params.id, req.body || {}, req.quem);
  res.json({ ok: true });
}));

// ------------------------------------------------------------ assinatura
r.get('/assinatura', exigir('ver'), h(async (req, res) => {
  const dados = await cobranca.dadosAssinatura(req.quem.contaId);
  const lista = req.quem.papel === 'dono' ? await cobranca.faturas(req.quem.contaId).catch(() => []) : [];
  res.json({ ...dados, faturas: lista });
}));
r.post('/assinatura', exigir('conta'), h(async (req, res) => res.json(await cobranca.assinar(req.quem, req.body?.plano))));
r.delete('/assinatura', exigir('conta'), h(async (req, res) => { await cobranca.cancelarAssinatura(req.quem); res.json({ ok: true }); }));

// ------------------------------------------------------------ conta
r.get('/conta', exigir('ver'), h(async (req, res) => res.json(await contas.situacaoConta(req.quem.contaId))));
r.put('/conta', exigir('conta'), h(async (req, res) => {
  await contas.atualizarConta(req.quem.contaId, req.body || {});
  await auditar(req.quem, 'conta.atualizar', req.quem.contaId);
  res.json(await contas.situacaoConta(req.quem.contaId));
}));
r.get('/painel', exigir('ver'), h(async (req, res) => res.json({
  ...(await notas.painel(req.quem.contaId)),
  certificadosVencendo: await prest.certificadosVencendo(req.quem.contaId, 30),
})));
r.get('/auditoria', exigir('equipe'), h(async (req, res) => res.json(await listarAuditoria(req.quem.contaId, req.query))));

// ------------------------------------------------------------ equipe
r.get('/equipe', exigir('ver'), h(async (req, res) => res.json(await contas.listarEquipe(req.quem.contaId))));
r.post('/equipe/convites', exigir('equipe'), h(async (req, res) => {
  if (!req.quem.usuarioId) throw invalido('Convites só podem ser enviados por um usuário.');
  await contas.convidar(req.quem.contaId, req.quem.usuarioId, req.body || {});
  await auditar(req.quem, 'equipe.convidar', req.body?.email, { papel: req.body?.papel });
  res.status(201).json(await contas.listarEquipe(req.quem.contaId));
}));
r.delete('/equipe/convites/:id', exigir('equipe'), h(async (req, res) => {
  await contas.cancelarConvite(req.quem.contaId, req.params.id);
  res.status(204).end();
}));
r.put('/equipe/:usuarioId', exigir('equipe'), h(async (req, res) => {
  await contas.alterarPapel(req.quem.contaId, req.params.usuarioId, req.body?.papel, req.quem);
  await auditar(req.quem, 'equipe.alterar_papel', req.params.usuarioId, { papel: req.body?.papel });
  res.json(await contas.listarEquipe(req.quem.contaId));
}));
r.delete('/equipe/:usuarioId', exigir('equipe'), h(async (req, res) => {
  await contas.removerMembro(req.quem.contaId, req.params.usuarioId, req.quem);
  await auditar(req.quem, 'equipe.remover', req.params.usuarioId);
  res.status(204).end();
}));

// ------------------------------------------------------------ integrações
r.get('/chaves', exigir('integracoes'), h(async (req, res) => res.json(await contas.listarChaves(req.quem.contaId))));
r.post('/chaves', exigir('integracoes'), h(async (req, res) => {
  const k = await contas.criarChave(req.quem.contaId, req.quem.usuarioId, req.body || {});
  await auditar(req.quem, 'api.criar_chave', k.id, { nome: k.nome });
  res.status(201).json(k);
}));
r.delete('/chaves/:id', exigir('integracoes'), h(async (req, res) => {
  await contas.revogarChave(req.quem.contaId, req.params.id);
  await auditar(req.quem, 'api.revogar_chave', req.params.id);
  res.status(204).end();
}));
r.get('/webhooks', exigir('integracoes'), h(async (req, res) => res.json(await wh.listarWebhooks(req.quem.contaId))));
r.get('/webhooks/entregas', exigir('integracoes'), h(async (req, res) => res.json(await wh.entregasRecentes(req.quem.contaId))));
r.post('/webhooks', exigir('integracoes'), h(async (req, res) => {
  const w = await wh.criarWebhook(req.quem.contaId, req.body || {});
  await auditar(req.quem, 'webhook.criar', w.id, { url: w.url });
  res.status(201).json(w);
}));
r.delete('/webhooks/:id', exigir('integracoes'), h(async (req, res) => {
  await wh.removerWebhook(req.quem.contaId, req.params.id);
  res.status(204).end();
}));

// ------------------------------------------------------------ prestadores
r.get('/prestadores', exigir('ver'), h(async (req, res) => res.json(await prest.listarPrestadores(req.quem.contaId))));
r.post('/prestadores', exigir('prestadores'), h(async (req, res) => {
  const p = await prest.criarPrestador(req.quem.contaId, req.body || {});
  await auditar(req.quem, 'prestador.criar', p.id, { documento: p.documento });
  res.status(201).json(p);
}));
r.get('/prestadores/:id', exigir('ver'), h(async (req, res) => res.json(await prest.obterPrestador(req.quem.contaId, req.params.id))));
r.put('/prestadores/:id', exigir('prestadores'), h(async (req, res) => {
  const p = await prest.atualizarPrestador(req.quem.contaId, req.params.id, req.body || {});
  await auditar(req.quem, 'prestador.atualizar', p.id, { ambiente: p.ambiente });
  res.json(p);
}));
r.delete('/prestadores/:id', exigir('prestadores'), h(async (req, res) => {
  await prest.desativarPrestador(req.quem.contaId, req.params.id);
  await auditar(req.quem, 'prestador.remover', req.params.id);
  res.status(204).end();
}));
r.post('/prestadores/:id/certificado', exigir('prestadores'), express.json({ limit: '2mb' }), h(async (req, res) => {
  const { pfxBase64, senha } = req.body || {};
  if (!pfxBase64) throw invalido('Envie o arquivo .pfx em base64.');
  const p = await prest.instalarCertificado(req.quem.contaId, req.params.id, Buffer.from(pfxBase64, 'base64'), senha || '');
  await auditar(req.quem, 'prestador.certificado', p.id, { validoAte: p.certificado.validoAte });
  res.json(p);
}));
r.get('/prestadores/:id/provedor', exigir('ver'), h(async (req, res) => {
  const p = await prest.obterPrestador(req.quem.contaId, req.params.id);
  const m = await mun.resolverMunicipio(req.quem.contaId, p.codigoMunicipio, p.provedor);
  res.json({ ...m, urls: undefined, opcoes: undefined, nomeProvedor: PROVEDORES[m.provedorEfetivo]?.nome });
}));
r.get('/prestadores/:id/parametros/:municipio', exigir('ver'), h(async (req, res) =>
  res.json(await notas.parametrosMunicipais(req.quem.contaId, req.params.id, req.params.municipio, req.query.servico))));

// ------------------------------------------------------------ municípios
r.get('/municipios', exigir('ver'), h(async (req, res) => res.json(await mun.listarMunicipios(req.quem.contaId))));
r.put('/municipios/:codigo', exigir('municipios'), h(async (req, res) => {
  await mun.salvarMunicipio(req.quem.contaId, req.params.codigo, req.body || {});
  await auditar(req.quem, 'municipio.salvar', req.params.codigo);
  res.json((await mun.listarMunicipios(req.quem.contaId))[req.params.codigo]);
}));
r.delete('/municipios/:codigo', exigir('municipios'), h(async (req, res) => {
  await mun.removerMunicipio(req.quem.contaId, req.params.codigo);
  res.status(204).end();
}));

// ------------------------------------------------------------ notas
r.get('/notas', exigir('ver'), h(async (req, res) => res.json(await notas.listarNotas(req.quem.contaId, req.query))));
r.post('/notas/previsualizar', exigir('emitir'), h(async (req, res) => res.json(await notas.previsualizar(req.quem.contaId, req.body || {}))));
r.post('/notas', exigir('emitir'), h(async (req, res) => {
  limitar(`emitir:${req.quem.contaId}`, { max: 120, janelaMs: 60_000 });
  const nota = await notas.emitir(req.quem, req.body || {}, {
    idempotencia: req.get('idempotency-key') || undefined,
    referencia: req.body?.referenciaExterna,
  });
  res.status(nota.repetida ? 200 : 201).json(nota);
}));

r.get('/notas.csv', exigir('ver'), h(async (req, res) => {
  const { itens } = await notas.listarNotas(req.quem.contaId, { ...req.query, porPagina: 200 });
  const cab = ['Prestador', 'Número', 'RPS/DPS', 'Status', 'Ambiente', 'Competência', 'Tomador', 'Doc. tomador', 'Valor serviço', 'ISS', 'ISS retido', 'Líquido', 'Chave/Código', 'Referência'];
  const linhas = [cab.join(';')];
  const cel = (v) => `"${(typeof v === 'number' ? v.toFixed(2).replace('.', ',') : String(v ?? '')).replace(/"/g, '""')}"`;
  for (const n of itens) {
    linhas.push([n.prestadorNome, n.numero, `${n.serie}/${n.numeroRps}`, n.status, n.ambiente, n.competencia, n.tomador?.nome, n.tomador?.documento,
      n.calculo?.valorServico, n.calculo?.valorIss, n.calculo?.valorIssRetido, n.calculo?.valorLiquido, n.chaveAcesso || n.codigoVerificacao, n.referenciaExterna].map(cel).join(';'));
  }
  res.type('text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="notas.csv"').send('﻿' + linhas.join('\n'));
}));

r.get('/notas/:id', exigir('ver'), h(async (req, res) => res.json(await notas.obterNota(req.quem.contaId, req.params.id))));
r.get('/notas/:id/eventos', exigir('ver'), h(async (req, res) => res.json(await notas.eventosDaNota(req.quem.contaId, req.params.id))));
r.post('/notas/:id/consultar', exigir('emitir'), h(async (req, res) => res.json(await notas.consultar(req.quem, req.params.id))));
r.post('/notas/:id/cancelar', exigir('cancelar'), h(async (req, res) => res.json(await notas.cancelar(req.quem, req.params.id, req.body || {}))));
r.get('/notas/:id/xml', exigir('ver'), h(async (req, res) => {
  const n = await notas.obterNota(req.quem.contaId, req.params.id, { comXml: true });
  const envio = req.query.tipo === 'envio';
  const xml = envio ? n.xmlEnvio : req.query.tipo === 'cancelamento' ? n.cancelamentoXml : (n.xmlRetorno || n.xmlEnvio);
  if (!xml) throw new ErroApp(404, 'XML não disponível para esta nota.');
  res.type('application/xml').set('Content-Disposition', `attachment; filename="nfse-${n.numero || 'rps-' + n.numeroRps}${envio ? '-envio' : ''}.xml"`).send(xml);
}));
r.get('/notas/:id/espelho', exigir('ver'), h(async (req, res) => {
  const n = await notas.obterNota(req.quem.contaId, req.params.id);
  const p = await prest.obterPrestador(req.quem.contaId, n.prestadorId).catch(() => null);
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'").type('html').send(espelhoHtml(n, p));
}));
r.get('/notas/:id/danfse', exigir('ver'), h(async (req, res) => {
  // Sem DANFSe oficial (prefeituras) ou ADN indisponível: usa o espelho imprimível.
  const d = await notas.danfseOficial(req.quem.contaId, req.params.id).catch(() => null);
  if (!d) return res.redirect('espelho');
  res.type(d.contentType).set('Content-Disposition', `inline; filename="danfse-${req.params.id}.pdf"`).send(d.body);
}));

export default r;
