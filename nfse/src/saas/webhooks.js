import crypto from 'node:crypto';
import { q, um, varios } from '../db/pool.js';
import { ErroApp, invalido, naoEncontrado } from './erros.js';
import { situacaoConta } from './contas.js';
import { exigirEnderecoPublico } from '../util/rede.js';

export const EVENTOS = ['nota.autorizada', 'nota.rejeitada', 'nota.cancelada', 'nota.processando'];
const ESPERAS_MIN = [1, 5, 30, 120, 360, 720]; // backoff entre tentativas

export async function listarWebhooks(contaId) {
  return varios('SELECT id, url, eventos, ativo, criado_em FROM webhooks WHERE conta_id = $1 ORDER BY criado_em', [contaId]);
}

export async function criarWebhook(contaId, { url, eventos }) {
  const sit = await situacaoConta(contaId);
  if (!sit.limites.webhooks) throw new ErroApp(402, 'Webhooks estão disponíveis a partir do plano Profissional.');
  let u;
  try { u = new URL(url); } catch { throw invalido('URL inválida.'); }
  if (u.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw invalido('O webhook deve usar https://.');
  await exigirEnderecoPublico(u.toString());
  const ev = (eventos?.length ? eventos : EVENTOS).filter((e) => EVENTOS.includes(e));
  const segredo = 'whsec_' + crypto.randomBytes(24).toString('base64url');
  const w = await um('INSERT INTO webhooks (conta_id, url, segredo, eventos) VALUES ($1, $2, $3, $4) RETURNING id, url, eventos, ativo',
    [contaId, u.toString(), segredo, ev]);
  return { ...w, segredo };
}

export async function removerWebhook(contaId, id) {
  const r = await q('DELETE FROM webhooks WHERE id = $1 AND conta_id = $2', [id, contaId]);
  if (!r.rowCount) throw naoEncontrado('Webhook');
}

export async function entregasRecentes(contaId) {
  return varios(`SELECT e.id, e.evento, e.tentativas, e.status_http, e.erro, e.entregue_em, e.criado_em, w.url
    FROM webhook_entregas e JOIN webhooks w ON w.id = e.webhook_id WHERE e.conta_id = $1 ORDER BY e.criado_em DESC LIMIT 50`, [contaId]);
}

/** Enfileira o evento para todos os webhooks da conta inscritos nele. */
export async function disparar(contaId, evento, dados) {
  const payload = { evento, criadoEm: new Date().toISOString(), dados };
  await q(`INSERT INTO webhook_entregas (webhook_id, conta_id, evento, payload)
           SELECT id, conta_id, $2, $3 FROM webhooks WHERE conta_id = $1 AND ativo AND $2 = ANY(eventos)`,
    [contaId, evento, JSON.stringify(payload)]);
  processarFila().catch(() => {});
}

/** Assinatura HMAC-SHA256 no formato "t=<unix>,v1=<hex>", sobre "<t>.<corpo>". */
export function assinar(segredo, corpo, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', segredo).update(`${t}.${corpo}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

let processando = false;
export async function processarFila() {
  if (processando) return;
  processando = true;
  try {
    const pendentes = await varios(`SELECT e.*, w.url, w.segredo FROM webhook_entregas e JOIN webhooks w ON w.id = e.webhook_id
      WHERE e.entregue_em IS NULL AND e.proxima_em <= now() AND e.tentativas < $1 AND w.ativo
      ORDER BY e.proxima_em LIMIT 50`, [ESPERAS_MIN.length + 1]);
    for (const e of pendentes) {
      const corpo = JSON.stringify(e.payload);
      let status = null, erro = null;
      try {
        await exigirEnderecoPublico(e.url); // o DNS pode ter mudado desde o cadastro
        const r = await fetch(e.url, {
          method: 'POST', body: corpo, signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'EmissorNFSe-Webhook/1.0', 'X-Assinatura': assinar(e.segredo, corpo), 'X-Evento': e.evento },
        });
        status = r.status;
        if (!r.ok) erro = `HTTP ${r.status}`;
      } catch (x) { erro = x.message; }
      const espera = ESPERAS_MIN[Math.min(e.tentativas, ESPERAS_MIN.length - 1)];
      await q(`UPDATE webhook_entregas SET tentativas = tentativas + 1, status_http = $2, erro = $3,
               entregue_em = CASE WHEN $3::text IS NULL THEN now() END,
               proxima_em = now() + make_interval(mins => $4) WHERE id = $1`, [e.id, status, erro, espera]);
    }
  } finally {
    processando = false;
  }
}

export function iniciarWorkerWebhooks() {
  return setInterval(() => processarFila().catch((e) => console.error('[webhooks]', e.message)), 30_000).unref();
}
