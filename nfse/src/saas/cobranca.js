import crypto from 'node:crypto';
import { q, um, varios, transacao } from '../db/pool.js';
import { config } from '../config.js';
import { asaas } from './asaas.js';
import { PLANOS, plano } from './planos.js';
import { ErroApp, invalido } from './erros.js';
import { situacaoConta } from './contas.js';
import { documentoValido } from '../core/validacao.js';
import { normDoc } from '../util/xml.js';
import { enviarEmail } from './email.js';
import { auditar } from './auditoria.js';

const hojeBR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

async function emailDoDono(contaId) {
  return (await um(`SELECT u.email, u.nome FROM membros m JOIN usuarios u ON u.id = m.usuario_id WHERE m.conta_id = $1 AND m.papel = 'dono'`, [contaId]));
}

export async function dadosAssinatura(contaId) {
  const c = await um(`SELECT assinatura_status, plano_contratado, pago_ate, atrasada_desde, asaas_assinatura_id FROM contas WHERE id = $1`, [contaId]);
  return {
    status: c.assinatura_status, planoContratado: c.plano_contratado, pagoAte: c.pago_ate, atrasadaDesde: c.atrasada_desde,
    disponivel: !!config.asaas.chave, temAssinatura: !!c.asaas_assinatura_id,
  };
}

/**
 * Assina um plano ou troca o plano da assinatura existente.
 * Retorna { urlPagamento } quando o cliente precisa pagar a primeira fatura.
 */
export async function assinar(quem, idPlano) {
  const p = PLANOS[idPlano];
  if (!p || idPlano === 'teste') throw invalido('Escolha um plano válido.');
  const conta = await um('SELECT * FROM contas WHERE id = $1', [quem.contaId]);
  if (!documentoValido(conta.documento)) throw invalido('Informe o CNPJ ou CPF para faturamento em "Dados da conta" antes de assinar.');
  const sit = await situacaoConta(quem.contaId);
  if (sit.uso.prestadores > p.prestadores || sit.uso.usuarios > p.usuarios)
    throw invalido(`O plano ${p.nome} permite ${p.prestadores} empresa(s) e ${p.usuarios} usuário(s). Remova o excedente antes de mudar.`);

  const descricao = `${config.nomeApp} — plano ${p.nome}`;

  // Já tem assinatura viva: só troca o plano (valor vale para as faturas em aberto e as próximas).
  if (conta.asaas_assinatura_id && ['ativa', 'atrasada', 'aguardando_pagamento'].includes(conta.assinatura_status)) {
    await asaas(`/subscriptions/${conta.asaas_assinatura_id}`, { metodo: 'PUT', corpo: { value: p.preco, description: descricao, updatePendingPayments: true } });
    await q(`UPDATE contas SET plano_contratado = $2, plano = CASE WHEN assinatura_status = 'ativa' THEN $2 ELSE plano END, atualizado_em = now() WHERE id = $1`, [conta.id, idPlano]);
    await auditar(quem, 'cobranca.trocar_plano', conta.id, { plano: idPlano });
    if (conta.assinatura_status === 'ativa') return { mudou: true };
    return { mudou: true, urlPagamento: await urlFaturaPendente(conta.asaas_assinatura_id) };
  }

  let cliente = conta.asaas_cliente_id;
  if (!cliente) {
    const dono = await emailDoDono(conta.id);
    cliente = (await asaas('/customers', { metodo: 'POST', corpo: {
      name: conta.nome, cpfCnpj: normDoc(conta.documento), email: dono?.email, externalReference: conta.id,
    } })).id;
    await q('UPDATE contas SET asaas_cliente_id = $2 WHERE id = $1', [conta.id, cliente]);
  }
  const assinatura = await asaas('/subscriptions', { metodo: 'POST', corpo: {
    customer: cliente, billingType: 'UNDEFINED', value: p.preco, nextDueDate: hojeBR(), cycle: 'MONTHLY',
    description: descricao, externalReference: conta.id,
  } });
  await q(`UPDATE contas SET asaas_assinatura_id = $2, assinatura_status = 'aguardando_pagamento', plano_contratado = $3, atualizado_em = now() WHERE id = $1`,
    [conta.id, assinatura.id, idPlano]);
  await auditar(quem, 'cobranca.assinar', conta.id, { plano: idPlano });
  return { urlPagamento: await urlFaturaPendente(assinatura.id) };
}

async function urlFaturaPendente(idAssinatura) {
  const { data = [] } = await asaas(`/subscriptions/${idAssinatura}/payments`);
  const pendente = data.find((f) => ['PENDING', 'OVERDUE'].includes(f.status)) || data[0];
  return pendente?.invoiceUrl || null;
}

export async function faturas(contaId) {
  const c = await um('SELECT asaas_assinatura_id FROM contas WHERE id = $1', [contaId]);
  if (!c.asaas_assinatura_id || !config.asaas.chave) return [];
  const { data = [] } = await asaas(`/subscriptions/${c.asaas_assinatura_id}/payments`);
  return data.map((f) => ({ id: f.id, valor: f.value, vencimento: f.dueDate, status: f.status, pagaEm: f.paymentDate || f.confirmedDate || null, url: f.invoiceUrl }));
}

export async function cancelarAssinatura(quem) {
  const c = await um('SELECT * FROM contas WHERE id = $1', [quem.contaId]);
  if (!c.asaas_assinatura_id || c.assinatura_status === 'cancelada') throw invalido('Não há assinatura ativa para cancelar.');
  await asaas(`/subscriptions/${c.asaas_assinatura_id}`, { metodo: 'DELETE' });
  await q(`UPDATE contas SET assinatura_status = 'cancelada', atualizado_em = now() WHERE id = $1`, [c.id]);
  await auditar(quem, 'cobranca.cancelar', c.id);
}

// ------------------------------------------------------------------ webhook

export function tokenWebhookValido(recebido) {
  const esperado = config.asaas.tokenWebhook;
  if (!esperado || !recebido) return false;
  const a = Buffer.from(String(recebido)), b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const somarMes = (data) => {
  const d = new Date(data + 'T23:59:59-03:00');
  d.setMonth(d.getMonth() + 1);
  return d.toISOString();
};

/** Processa um evento do Asaas. Idempotente pelo id do evento. */
export async function processarEvento(ev) {
  const idEvento = ev.id || `${ev.event}:${ev.payment?.id || ev.subscription?.id}:${ev.payment?.status || ''}`;
  const idAssinatura = ev.payment?.subscription || ev.subscription?.id;
  const conta = idAssinatura && await um('SELECT * FROM contas WHERE asaas_assinatura_id = $1', [idAssinatura]);

  return transacao(async (c) => {
    const novo = await c.query(`INSERT INTO asaas_eventos (id, tipo, conta_id, payload) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [idEvento, ev.event, conta?.id || null, JSON.stringify(ev)]);
    if (!novo.rowCount || !conta) return { ignorado: true };

    switch (ev.event) {
      case 'PAYMENT_CONFIRMED':
      case 'PAYMENT_RECEIVED': {
        const pagoAte = somarMes(ev.payment.dueDate);
        await c.query(`UPDATE contas SET plano = coalesce(plano_contratado, plano), assinatura_status = 'ativa', atrasada_desde = NULL,
            pago_ate = GREATEST(coalesce(pago_ate, $2::timestamptz), $2::timestamptz),
            status = CASE WHEN status = 'suspensa' AND motivo_suspensao = 'inadimplencia' THEN 'ativa' ELSE status END,
            motivo_suspensao = CASE WHEN motivo_suspensao = 'inadimplencia' THEN NULL ELSE motivo_suspensao END,
            atualizado_em = now() WHERE id = $1`, [conta.id, pagoAte]);
        break;
      }
      case 'PAYMENT_OVERDUE':
      case 'PAYMENT_REFUNDED':
      case 'PAYMENT_CHARGEBACK_REQUESTED':
        await c.query(`UPDATE contas SET assinatura_status = 'atrasada', atrasada_desde = coalesce(atrasada_desde, $2::date::timestamptz, now()),
            atualizado_em = now() WHERE id = $1 AND assinatura_status <> 'cancelada'`, [conta.id, ev.event === 'PAYMENT_OVERDUE' ? ev.payment.dueDate : null]);
        break;
      case 'SUBSCRIPTION_DELETED':
      case 'SUBSCRIPTION_INACTIVATED':
        await c.query(`UPDATE contas SET assinatura_status = 'cancelada', atualizado_em = now() WHERE id = $1`, [conta.id]);
        break;
      default:
        return { ignorado: true };
    }
    return { processado: true, contaId: conta.id };
  });
}

// ------------------------------------------------------------------ rotina diária

/** Suspende inadimplentes após a tolerância e encerra planos cancelados ao fim do período pago. */
export async function verificarAssinaturas() {
  const suspensas = await varios(`UPDATE contas SET status = 'suspensa', motivo_suspensao = 'inadimplencia', atualizado_em = now()
    WHERE assinatura_status = 'atrasada' AND status = 'ativa' AND atrasada_desde < now() - make_interval(days => $1)
    RETURNING id, nome`, [config.asaas.diasTolerancia]);
  for (const c of suspensas) {
    const dono = await emailDoDono(c.id);
    if (dono) await enviarEmail({
      para: dono.email, assunto: `Conta suspensa por falta de pagamento — ${config.nomeApp}`, titulo: 'Sua conta foi suspensa',
      corpo: '<p>Não identificamos o pagamento da sua assinatura. A emissão de notas está bloqueada até a regularização; seus dados e notas continuam guardados.</p>',
      botao: { texto: 'Ver faturas', url: `${config.urlApp}/app.html#/conta` },
    }).catch(() => {});
  }
  const encerradas = await varios(`UPDATE contas SET plano = 'teste', teste_ate = now(), plano_contratado = NULL, atualizado_em = now()
    WHERE assinatura_status = 'cancelada' AND plano <> 'teste' AND (pago_ate IS NULL OR pago_ate < now()) RETURNING id`);
  return { suspensas: suspensas.length, encerradas: encerradas.length };
}

export function iniciarRotinaCobranca() {
  const rodar = () => verificarAssinaturas().catch((e) => console.error('[cobranca]', e.message));
  setTimeout(rodar, 60_000).unref();
  return setInterval(rodar, 3600_000).unref();
}

export { plano };
