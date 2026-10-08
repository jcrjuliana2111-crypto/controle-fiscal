import express from 'express';
import * as svc from '../core/emissao.js';
import { listarMunicipios, salvarMunicipio, removerMunicipio, resolverMunicipio } from '../core/municipios.js';
import { PROVEDORES, PRESETS } from '../providers/index.js';
import { MOTIVOS_CANCELAMENTO } from '../providers/nacional.js';
import { calcular } from '../core/calculo.js';
import { espelhoHtml } from '../espelho.js';
import { config } from '../config.js';

const r = express.Router();
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// Autenticação por token (opcional, recomendada se o servidor não for local).
r.use((req, res, next) => {
  if (!config.apiToken) return next();
  const tok = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.query.token;
  if (tok === config.apiToken) return next();
  res.status(401).json({ erro: 'Token de acesso inválido.' });
});

r.get('/info', (req, res) => res.json({
  provedores: Object.values(PROVEDORES).map((p) => ({ id: p.id, nome: p.nome })),
  presetsAbrasf: Object.entries(PRESETS).map(([id, p]) => ({ id, nome: p.nome })),
  motivosCancelamento: MOTIVOS_CANCELAMENTO,
}));

// Prestadores
r.get('/prestadores', (req, res) => res.json(svc.listarPrestadores()));
r.post('/prestadores', h((req, res) => res.status(201).json(svc.salvarPrestador(req.body))));
r.put('/prestadores/:id', h((req, res) => res.json(svc.salvarPrestador({ ...req.body, id: req.params.id }))));
r.delete('/prestadores/:id', h((req, res) => { svc.removerPrestador(req.params.id); res.status(204).end(); }));
r.post('/prestadores/:id/certificado', express.json({ limit: '2mb' }), h((req, res) => {
  const { pfxBase64, senha } = req.body || {};
  if (!pfxBase64) return res.status(400).json({ erro: 'Envie o arquivo .pfx em base64.' });
  res.json(svc.instalarCertificado(req.params.id, Buffer.from(pfxBase64, 'base64'), senha || ''));
}));
r.get('/prestadores/:id/provedor', h((req, res) => {
  const p = svc.obterPrestador(req.params.id);
  if (!p) return res.status(404).json({ erro: 'Prestador não encontrado.' });
  const m = resolverMunicipio(p.codigoMunicipio, p.provedor);
  res.json({ ...m, nomeProvedor: PROVEDORES[m.provedorEfetivo]?.nome });
}));
r.get('/prestadores/:id/parametros/:municipio', h(async (req, res) =>
  res.json(await svc.parametrosMunicipais(req.params.id, req.params.municipio, req.query.servico))));

// Municípios com sistema próprio
r.get('/municipios', (req, res) => res.json(listarMunicipios()));
r.put('/municipios/:codigo', h((req, res) => { salvarMunicipio(req.params.codigo, req.body); res.json(listarMunicipios()[req.params.codigo]); }));
r.delete('/municipios/:codigo', h((req, res) => { removerMunicipio(req.params.codigo); res.status(204).end(); }));

// Notas
r.post('/calcular', (req, res) => res.json(calcular(req.body || {})));
r.get('/notas', (req, res) => res.json(svc.listarNotas(req.query)));
r.post('/notas/previsualizar', h((req, res) => res.json(svc.previsualizar(req.body))));
r.post('/notas', h(async (req, res) => res.status(201).json(await svc.emitir(req.body))));
r.get('/notas/:id', h((req, res) => {
  const n = svc.obterNota(req.params.id);
  if (!n) return res.status(404).json({ erro: 'Nota não encontrada.' });
  const { xmlEnvio, xmlRetorno, ...resto } = n;
  res.json(resto);
}));
r.post('/notas/:id/consultar', h(async (req, res) => res.json(await svc.consultar(req.params.id))));
r.post('/notas/:id/cancelar', h(async (req, res) => res.json(await svc.cancelar(req.params.id, req.body || {}))));
r.get('/notas/:id/xml', h((req, res) => {
  const n = svc.obterNota(req.params.id);
  if (!n) return res.status(404).json({ erro: 'Nota não encontrada.' });
  const qual = req.query.tipo === 'envio' ? n.xmlEnvio : (n.xmlRetorno || n.xmlEnvio);
  res.type('application/xml')
    .set('Content-Disposition', `attachment; filename="nfse-${n.numero || 'rps-' + n.numeroRps}${req.query.tipo === 'envio' ? '-envio' : ''}.xml"`)
    .send(qual || '');
}));
r.get('/notas/:id/espelho', h((req, res) => {
  const n = svc.obterNota(req.params.id);
  if (!n) return res.status(404).send('Nota não encontrada.');
  res.type('html').send(espelhoHtml(n, svc.obterPrestador(n.prestadorId)));
}));
r.get('/notas/:id/danfse', h(async (req, res) => {
  const espelho = `espelho${req.query.token ? '?token=' + encodeURIComponent(req.query.token) : ''}`;
  // Sem DANFSe oficial (prefeituras) ou ADN indisponível: usa o espelho imprimível.
  const d = await svc.danfseOficial(req.params.id).catch(() => null);
  if (!d) return res.redirect(espelho);
  res.type(d.contentType).set('Content-Disposition', `inline; filename="danfse-${req.params.id}.pdf"`).send(d.body);
}));

r.get('/notas.csv', (req, res) => {
  const notas = svc.listarNotas(req.query);
  const linhas = [['Prestador', 'Número', 'RPS/DPS', 'Status', 'Ambiente', 'Competência', 'Tomador', 'Doc. tomador', 'Valor serviço', 'ISS', 'ISS retido', 'Líquido', 'Chave/Código'].join(';')];
  for (const n of notas) {
    linhas.push([n.prestadorNome, n.numero || '', `${n.serie}/${n.numeroRps}`, n.status, n.ambiente, n.competencia || '',
      n.tomador?.nome || '', n.tomador?.documento || '', n.calculo?.valorServico, n.calculo?.valorIss, n.calculo?.valorIssRetido,
      n.calculo?.valorLiquido, n.chaveAcesso || n.codigoVerificacao || '']
      .map((v) => `"${(typeof v === 'number' ? v.toFixed(2).replace('.', ',') : String(v ?? '')).replace(/"/g, '""')}"`).join(';'));
  }
  res.type('text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="nfse.csv"').send('﻿' + linhas.join('\n'));
});

r.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ erro: err.message, erros: err.erros });
});

export default r;
