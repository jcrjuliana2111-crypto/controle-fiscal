import express from 'express';
import { q, varios, um } from '../db/pool.js';
import { PLANOS } from '../saas/planos.js';
import { invalido, naoEncontrado } from '../saas/erros.js';
import { auditar } from '../saas/auditoria.js';
import * as mun from '../core/municipios.js';
import * as fiscal from '../integra/servico.js';
import { h, exigirSuperadmin } from './middleware.js';

// Administração da plataforma (você, dono do SaaS).
const r = express.Router();
r.use(exigirSuperadmin);

r.get('/resumo', h(async (req, res) => res.json(await um(`SELECT
    (SELECT count(*)::int FROM contas) AS contas,
    (SELECT count(*)::int FROM contas WHERE plano <> 'teste' AND status = 'ativa') AS pagantes,
    (SELECT count(*)::int FROM usuarios) AS usuarios,
    (SELECT count(*)::int FROM notas WHERE ambiente = 'producao' AND status = 'autorizada' AND criado_em >= date_trunc('month', now())) AS notas_mes`))));

r.get('/contas', h(async (req, res) => res.json(await varios(`SELECT c.*,
    (SELECT u.email FROM membros m JOIN usuarios u ON u.id = m.usuario_id WHERE m.conta_id = c.id AND m.papel = 'dono') AS dono,
    (SELECT count(*)::int FROM prestadores p WHERE p.conta_id = c.id AND p.ativo) AS prestadores,
    (SELECT count(*)::int FROM notas n WHERE n.conta_id = c.id AND n.ambiente = 'producao' AND n.status = 'autorizada'
       AND n.criado_em >= date_trunc('month', now())) AS notas_mes
    FROM contas c WHERE ($1::text IS NULL OR c.nome ILIKE '%' || $1 || '%') ORDER BY c.criado_em DESC LIMIT 200`, [req.query.busca || null]))));

r.put('/contas/:id', h(async (req, res) => {
  const { plano, status, testeAte } = req.body || {};
  if (plano && !PLANOS[plano]) throw invalido('Plano inválido.');
  if (status && !['ativa', 'suspensa', 'cancelada'].includes(status)) throw invalido('Status inválido.');
  const c = await um(`UPDATE contas SET plano = coalesce($2, plano), status = coalesce($3, status), teste_ate = coalesce($4::timestamptz, teste_ate),
    motivo_suspensao = CASE WHEN $3 = 'suspensa' THEN 'manual' WHEN $3 = 'ativa' THEN NULL ELSE motivo_suspensao END,
    atualizado_em = now() WHERE id = $1 RETURNING *`, [req.params.id, plano || null, status || null, testeAte || null]);
  if (!c) throw naoEncontrado('Conta');
  await auditar({ ...req.quem, contaId: c.id }, 'admin.alterar_conta', c.id, { plano, status, testeAte });
  res.json(c);
}));

r.get('/integra', h(async (req, res) => res.json({ config: await fiscal.configPublica(), consumo: await fiscal.consumoPlataforma() })));
r.put('/integra', express.json({ limit: '2mb' }), h(async (req, res) => res.json(await fiscal.salvarConfig(req.body || {}, req.quem))));
r.put('/contas/:id/integra', h(async (req, res) => {
  await fiscal.definirContaPropria(req.params.id, req.body?.contaPropria);
  await auditar({ ...req.quem, contaId: req.params.id }, 'admin.integra_conta_propria', req.params.id, { contaPropria: !!req.body?.contaPropria });
  res.json({ ok: true });
}));

r.put('/municipios/:codigo', h(async (req, res) => {
  await mun.salvarMunicipio(null, req.params.codigo, req.body || {});
  res.json({ ok: true });
}));
r.delete('/municipios/:codigo', h(async (req, res) => {
  await mun.removerMunicipio(null, req.params.codigo);
  res.status(204).end();
}));

export default r;
