import { q, um, varios } from '../db/pool.js';
import { provedor } from '../providers/index.js';
import { resolverMunicipio } from './municipios.js';
import { obterPrestador, carregarCertificado } from './prestadores.js';
import { validarNota } from './validacao.js';
import { calcular } from './calculo.js';
import { ErroApp, invalido, naoEncontrado } from '../saas/erros.js';
import { situacaoConta } from '../saas/contas.js';
import { disparar } from '../saas/webhooks.js';
import { auditar } from '../saas/auditoria.js';

const CAMPOS_RESUMO = `id, prestador_id, provedor, ambiente, municipio, serie, numero_rps, status, numero, chave_acesso, id_dps,
  codigo_verificacao, link_consulta, competencia, tomador, servico, valores, ibs_cbs, calculo, mensagens, cancelamento,
  referencia_externa, data_autorizacao, criado_em, atualizado_em`;

export function notaDeLinha(r) {
  if (!r) return null;
  return {
    id: r.id, prestadorId: r.prestador_id, prestadorNome: r.prestador_nome, provedor: r.provedor, ambiente: r.ambiente,
    municipio: r.municipio, serie: r.serie, numeroRps: r.numero_rps, status: r.status, numero: r.numero,
    chaveAcesso: r.chave_acesso, idDps: r.id_dps, codigoVerificacao: r.codigo_verificacao, linkConsulta: r.link_consulta,
    competencia: r.competencia, tomador: r.tomador, servico: r.servico, valores: r.valores, ibsCbs: r.ibs_cbs,
    calculo: r.calculo, mensagens: r.mensagens, cancelamento: r.cancelamento ? { ...r.cancelamento, xml: undefined } : null,
    referenciaExterna: r.referencia_externa, dataAutorizacao: r.data_autorizacao, criadoEm: r.criado_em, atualizadoEm: r.atualizado_em,
    ...(r.xml_envio !== undefined ? { xmlEnvio: r.xml_envio, xmlRetorno: r.xml_retorno } : {}),
  };
}

async function contexto(contaId, prestadorId, extra = {}) {
  const p = await obterPrestador(contaId, prestadorId, { comSegredos: true });
  const municipio = await resolverMunicipio(contaId, p.codigoMunicipio, p.provedor);
  return { prestador: p, municipio, ambiente: p.ambiente, cert: carregarCertificado(p), prov: provedor(municipio.provedorEfetivo), ...extra };
}

function exigirValida(nota, p) {
  const erros = validarNota(nota, p);
  if (erros.length) throw invalido('Dados inválidos: ' + erros.map((e) => e.mensagem).join(' '), erros);
}

async function evento(nota, tipo, status, detalhes, ctx) {
  await q('INSERT INTO eventos_nota (nota_id, conta_id, tipo, status, detalhes, usuario_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [nota.id, nota.contaId || ctx.contaId, tipo, status, detalhes ? JSON.stringify(detalhes) : null, ctx.usuarioId || null]);
}

// ---------------------------------------------------------------- consulta

export async function listarNotas(contaId, f = {}) {
  const cond = ['n.conta_id = $1'];
  const p = [contaId];
  const add = (sql, v) => { p.push(v); cond.push(sql.replace('?', '$' + p.length)); };
  if (f.prestadorId) add('n.prestador_id = ?', f.prestadorId);
  if (f.status) add('n.status = ?', f.status);
  if (f.ambiente) add('n.ambiente = ?', f.ambiente);
  if (f.de) add('n.criado_em >= ?::date', f.de);
  if (f.ate) add("n.criado_em < ?::date + interval '1 day'", f.ate);
  if (f.busca) add(`(n.tomador->>'nome' ILIKE ? OR n.tomador->>'documento' ILIKE $${p.length} OR n.numero ILIKE $${p.length}
                     OR n.chave_acesso ILIKE $${p.length} OR n.referencia_externa ILIKE $${p.length})`, `%${String(f.busca).trim()}%`);
  const porPagina = Math.min(Math.max(Number(f.porPagina) || 50, 1), 200);
  const pagina = Math.max(Number(f.pagina) || 1, 1);
  const where = cond.join(' AND ');
  const total = (await um(`SELECT count(*)::int AS n FROM notas n WHERE ${where}`, p)).n;
  const itens = await varios(`SELECT ${CAMPOS_RESUMO.split(',').map((c) => 'n.' + c.trim()).join(', ')}, pr.razao_social AS prestador_nome
    FROM notas n JOIN prestadores pr ON pr.id = n.prestador_id WHERE ${where}
    ORDER BY n.criado_em DESC LIMIT ${porPagina} OFFSET ${(pagina - 1) * porPagina}`, p);
  return { itens: itens.map(notaDeLinha), total, pagina, porPagina };
}

export async function obterNota(contaId, id, { comXml = false } = {}) {
  const r = await um(`SELECT n.*, pr.razao_social AS prestador_nome FROM notas n JOIN prestadores pr ON pr.id = n.prestador_id
                      WHERE n.id = $1 AND n.conta_id = $2`, [id, contaId]);
  if (!r) throw naoEncontrado('Nota');
  const n = notaDeLinha(comXml ? r : { ...r, xml_envio: undefined, xml_retorno: undefined });
  n.contaId = contaId;
  if (comXml) n.cancelamentoXml = r.cancelamento?.xml;
  return n;
}

export async function eventosDaNota(contaId, id) {
  return varios(`SELECT e.tipo, e.status, e.detalhes, e.criado_em, u.nome AS usuario FROM eventos_nota e
    LEFT JOIN usuarios u ON u.id = e.usuario_id WHERE e.nota_id = $1 AND e.conta_id = $2 ORDER BY e.id`, [id, contaId]);
}

export async function previsualizar(contaId, nota) {
  const ctx = await contexto(contaId, nota.prestadorId);
  exigirValida(nota, ctx.prestador);
  Object.assign(ctx, { nota, serie: ctx.prestador.serie, numero: ctx.prestador.proximoNumero });
  const r = ctx.prov.gerarXml(ctx);
  return { provedor: ctx.prov.nome, ambiente: ctx.ambiente, calculo: calcular(nota.valores), ...r };
}

// ---------------------------------------------------------------- emissão

/**
 * Emite uma NFS-e.
 * @param {{contaId, usuarioId?, chaveApiId?, ip?}} quem
 * @param {object} nota
 * @param {{idempotencia?: string, referencia?: string}} [opts]
 */
export async function emitir(quem, nota, { idempotencia, referencia } = {}) {
  const { contaId } = quem;
  if (idempotencia) {
    const ja = await um('SELECT id FROM notas WHERE conta_id = $1 AND chave_idempotencia = $2', [contaId, idempotencia]);
    if (ja) return { ...(await obterNota(contaId, ja.id)), repetida: true };
  }

  const ctx = await contexto(contaId, nota.prestadorId);
  const p = ctx.prestador;
  exigirValida(nota, p);

  const sit = await situacaoConta(contaId);
  if (sit.status !== 'ativa') throw new ErroApp(403, 'Conta suspensa. Regularize a assinatura para emitir notas.');
  if (p.ambiente === 'producao') {
    if (sit.testeExpirado) throw new ErroApp(402, 'Seu período de teste terminou. Assine um plano para emitir em produção.');
    if (sit.uso.notasMes >= sit.limites.notasMes)
      throw new ErroApp(402, `Limite de ${sit.limites.notasMes} notas/mês do plano ${sit.nomePlano} atingido. Faça upgrade para continuar emitindo.`);
  }
  if (!ctx.cert) throw invalido('Instale o certificado digital A1 do prestador antes de emitir.');

  // Reserva o número de forma atômica (várias instâncias/usuários ao mesmo tempo).
  const { numero, serie } = await um(`UPDATE prestadores SET proximo_numero = proximo_numero + 1
    WHERE id = $1 AND conta_id = $2 RETURNING proximo_numero - 1 AS numero, serie`, [p.id, contaId]);

  let linha;
  try {
    linha = await um(`INSERT INTO notas (conta_id, prestador_id, provedor, ambiente, municipio, serie, numero_rps, status, competencia,
        tomador, servico, valores, ibs_cbs, calculo, referencia_externa, chave_idempotencia, criado_por)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'enviando', $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
    [contaId, p.id, ctx.prov.id, p.ambiente, ctx.municipio.nome || p.municipio, serie, numero, nota.competencia || null,
      nota.tomador || {}, nota.servico || {}, nota.valores || {}, nota.ibsCbs || null, calcular(nota.valores),
      referencia || null, idempotencia || null, quem.usuarioId || null]);
  } catch (e) {
    await devolverNumero(p.id, numero);
    if (e.code === '23505' && e.constraint === 'notas_idempotencia') return emitir(quem, nota, { idempotencia, referencia });
    if (e.code === '23505') throw new ErroApp(409, `O número ${numero} (série ${serie}) já foi usado. Ajuste o "próximo número" do prestador.`);
    throw e;
  }

  Object.assign(ctx, { nota, serie, numero });
  let r;
  try {
    r = await ctx.prov.emitir(ctx);
  } catch (e) {
    // Sem resposta: a nota pode ter sido recebida. Fica "processando" para consulta (evita duplicidade).
    r = { status: 'processando', mensagens: [{ codigo: 'COMUNICACAO', mensagem: e.message }] };
  }

  await q(`UPDATE notas SET status = $2, numero = $3, chave_acesso = $4, id_dps = $5, codigo_verificacao = $6, link_consulta = $7,
      data_autorizacao = $8, mensagens = $9, xml_envio = $10, xml_retorno = $11, atualizado_em = now() WHERE id = $1`,
  [linha.id, r.status, r.numero || null, r.chaveAcesso || null, r.idDps || null, r.codigoVerificacao || null, r.linkConsulta || null,
    r.dataAutorizacao || (r.status === 'autorizada' ? new Date().toISOString() : null), JSON.stringify(r.mensagens || []),
    r.xmlEnvio || null, r.xmlRetorno || null]);

  // Rejeição ou teste: o número não foi usado pelo fisco e volta a ficar disponível.
  if (r.status === 'rejeitada' || r.status === 'validada') await devolverNumero(p.id, numero);

  const resumo = await obterNota(contaId, linha.id);
  await evento(resumo, 'emissao', r.status, { mensagens: r.mensagens }, quem);
  await auditar(quem, 'nota.emitir', linha.id, { status: r.status, numero: r.numero, ambiente: p.ambiente });
  await notificar(contaId, resumo);
  return resumo;
}

async function devolverNumero(prestadorId, numero) {
  await q('UPDATE prestadores SET proximo_numero = $2 WHERE id = $1 AND proximo_numero = $3', [prestadorId, numero, numero + 1]);
}

const EVENTO_POR_STATUS = { autorizada: 'nota.autorizada', rejeitada: 'nota.rejeitada', cancelada: 'nota.cancelada', processando: 'nota.processando' };
async function notificar(contaId, nota) {
  const ev = EVENTO_POR_STATUS[nota.status];
  if (ev) await disparar(contaId, ev, nota).catch((e) => console.error('[webhooks]', e.message));
}

// ---------------------------------------------------------------- pós-emissão

async function contextoDaNota(contaId, id) {
  const nota = await obterNota(contaId, id, { comXml: true });
  const ctx = await contexto(contaId, nota.prestadorId, { nota, serie: nota.serie, numero: nota.numeroRps, ambiente: nota.ambiente });
  ctx.prov = provedor(nota.provedor);
  ctx.municipio = await resolverMunicipio(contaId, ctx.prestador.codigoMunicipio, nota.provedor);
  return { nota, ctx };
}

export async function consultar(quem, id) {
  const { nota, ctx } = await contextoDaNota(quem.contaId, id);
  const r = await ctx.prov.consultar(ctx, nota);
  await q(`UPDATE notas SET status = coalesce($2, status), numero = coalesce($3, numero), chave_acesso = coalesce($4, chave_acesso),
      codigo_verificacao = coalesce($5, codigo_verificacao), xml_retorno = coalesce($6, xml_retorno),
      mensagens = CASE WHEN $7::jsonb = '[]'::jsonb THEN mensagens ELSE $7::jsonb END,
      data_autorizacao = CASE WHEN $2 = 'autorizada' THEN coalesce(data_autorizacao, now()) ELSE data_autorizacao END,
      atualizado_em = now() WHERE id = $1 AND conta_id = $8`,
  [id, r.status || null, r.numero || null, r.chaveAcesso || null, r.codigoVerificacao || null, r.xmlRetorno || null,
    JSON.stringify(r.mensagens || []), quem.contaId]);
  const atual = await obterNota(quem.contaId, id);
  await evento(atual, 'consulta', atual.status, null, quem);
  if (atual.status !== nota.status) await notificar(quem.contaId, atual);
  return atual;
}

export async function cancelar(quem, id, { codigo, motivo }) {
  const { nota, ctx } = await contextoDaNota(quem.contaId, id);
  if (nota.status !== 'autorizada') throw invalido('Só é possível cancelar notas autorizadas.');
  if (!ctx.cert) throw invalido('Certificado do prestador não instalado.');
  const r = await ctx.prov.cancelar(ctx, nota, { codigo, motivo });
  if (r.sucesso) {
    await q(`UPDATE notas SET status = 'cancelada', cancelamento = $2, mensagens = $3, atualizado_em = now() WHERE id = $1`,
      [id, JSON.stringify({ em: new Date().toISOString(), codigo, motivo, xml: r.xmlRetorno }), JSON.stringify(r.mensagens || [])]);
  } else {
    await q('UPDATE notas SET mensagens = $2, atualizado_em = now() WHERE id = $1', [id, JSON.stringify(r.mensagens || [])]);
  }
  const atual = await obterNota(quem.contaId, id);
  await evento(atual, 'cancelamento', r.sucesso ? 'cancelada' : 'recusado', { codigo, motivo, mensagens: r.mensagens }, quem);
  await auditar(quem, 'nota.cancelar', id, { sucesso: r.sucesso, codigo });
  if (r.sucesso) await notificar(quem.contaId, atual);
  return { sucesso: r.sucesso, mensagens: r.mensagens, nota: atual };
}

export async function danfseOficial(contaId, id) {
  const { nota, ctx } = await contextoDaNota(contaId, id);
  if (!ctx.prov.danfse) return null;
  return ctx.prov.danfse(ctx, nota);
}

export async function parametrosMunicipais(contaId, prestadorId, codigoMunicipio, codigoServico) {
  const ctx = await contexto(contaId, prestadorId);
  return provedor('nacional').parametrosMunicipais(ctx, codigoMunicipio, codigoServico);
}

// ---------------------------------------------------------------- painel

export async function painel(contaId) {
  const mes = await um(`SELECT
      count(*) FILTER (WHERE status = 'autorizada')::int AS autorizadas,
      count(*) FILTER (WHERE status = 'rejeitada')::int AS rejeitadas,
      count(*) FILTER (WHERE status IN ('processando', 'enviando'))::int AS pendentes,
      count(*) FILTER (WHERE status = 'cancelada')::int AS canceladas,
      coalesce(sum((calculo->>'valorServico')::numeric) FILTER (WHERE status = 'autorizada'), 0)::float AS faturado,
      coalesce(sum((calculo->>'valorIss')::numeric) FILTER (WHERE status = 'autorizada'), 0)::float AS iss,
      coalesce(sum((calculo->>'valorIssRetido')::numeric) FILTER (WHERE status = 'autorizada'), 0)::float AS iss_retido
    FROM notas WHERE conta_id = $1 AND ambiente = 'producao'
      AND criado_em >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`, [contaId]);
  const serie = await varios(`SELECT to_char(date_trunc('month', criado_em AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS mes,
      count(*)::int AS notas, coalesce(sum((calculo->>'valorServico')::numeric), 0)::float AS valor
    FROM notas WHERE conta_id = $1 AND ambiente = 'producao' AND status = 'autorizada'
      AND criado_em >= date_trunc('month', now()) - interval '5 months'
    GROUP BY 1 ORDER BY 1`, [contaId]);
  return { mes, serie };
}
