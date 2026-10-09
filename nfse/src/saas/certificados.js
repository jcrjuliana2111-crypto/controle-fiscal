import { q, um, varios } from '../db/pool.js';
import { config } from '../config.js';
import { invalido, naoEncontrado, ErroApp } from './erros.js';
import { enviarEmail } from './email.js';
import { disparar } from './webhooks.js';
import { lerCertificado } from '../core/certificado.js';
import { normDoc } from '../util/xml.js';
import { documentoValido, cpfValido } from '../core/validacao.js';

export const TIPOS = ['e-CNPJ A1', 'e-CPF A1', 'e-CNPJ A3', 'e-CPF A3', 'NF-e A1', 'Outro'];
export const MARCOS = [30, 15, 7, 1, 0]; // dias antes do vencimento em que avisamos
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const deLinha = (r) => r && ({
  id: r.id, prestadorId: r.prestador_id, titular: r.titular, documento: r.documento, tipo: r.tipo, emissor: r.emissor,
  vencimento: r.vencimento, clienteNome: r.cliente_nome, clienteEmail: r.cliente_email, clienteTelefone: r.cliente_telefone,
  avisarCliente: r.avisar_cliente, observacao: r.observacao, dias: r.dias, empresa: r.empresa,
});

// ------------------------------------------------------------------ carteira

export async function listarCertificados(contaId, { filtro } = {}) {
  const cond = filtro === 'vencidos' ? 'AND c.vencimento < current_date'
    : filtro === '30' ? 'AND c.vencimento BETWEEN current_date AND current_date + 30'
    : filtro === '90' ? 'AND c.vencimento BETWEEN current_date AND current_date + 90' : '';
  return (await varios(`SELECT c.*, (c.vencimento - (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS dias, p.razao_social AS empresa
    FROM certificados c LEFT JOIN prestadores p ON p.id = c.prestador_id
    WHERE c.conta_id = $1 ${cond} ORDER BY c.vencimento`, [contaId])).map(deLinha);
}

export async function resumoCertificados(contaId) {
  return um(`SELECT count(*) FILTER (WHERE vencimento < current_date)::int AS vencidos,
      count(*) FILTER (WHERE vencimento BETWEEN current_date AND current_date + 30)::int AS ate30,
      count(*) FILTER (WHERE vencimento BETWEEN current_date + 31 AND current_date + 90)::int AS ate90,
      count(*)::int AS total FROM certificados WHERE conta_id = $1`, [contaId]);
}

function normalizar(d) {
  if (!d.titular?.trim()) throw invalido('Informe o titular do certificado.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.vencimento || ''))) throw invalido('Informe a data de vencimento.');
  if (d.documento && !documentoValido(d.documento)) throw invalido('CNPJ/CPF do titular inválido.');
  if (d.avisarCliente && !d.clienteEmail) throw invalido('Para avisar o cliente, informe o e-mail dele.');
  return [d.titular.trim(), d.documento ? normDoc(d.documento) : null, TIPOS.includes(d.tipo) ? d.tipo : 'e-CNPJ A1', d.emissor || null,
    d.vencimento, d.clienteNome || null, d.clienteEmail || null, d.clienteTelefone || null, !!d.avisarCliente, d.observacao || null];
}

export async function salvarCertificado(contaId, d) {
  const v = normalizar(d);
  if (d.id) {
    const r = await um(`UPDATE certificados SET titular = $3, documento = $4, tipo = $5, emissor = $6,
        avisos_enviados = CASE WHEN vencimento <> $7::date THEN '{}' ELSE avisos_enviados END, vencimento = $7,
        cliente_nome = $8, cliente_email = $9, cliente_telefone = $10, avisar_cliente = $11, observacao = $12, atualizado_em = now()
        WHERE id = $1 AND conta_id = $2 RETURNING *`, [d.id, contaId, ...v]);
    if (!r) throw naoEncontrado('Certificado');
    return deLinha(r);
  }
  return deLinha(await um(`INSERT INTO certificados (conta_id, titular, documento, tipo, emissor, vencimento, cliente_nome, cliente_email,
      cliente_telefone, avisar_cliente, observacao) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`, [contaId, ...v]));
}

export async function removerCertificado(contaId, id) {
  const r = await q('DELETE FROM certificados WHERE id = $1 AND conta_id = $2 AND prestador_id IS NULL', [id, contaId]);
  if (!r.rowCount) throw invalido('Certificados de empresas emitentes são atualizados pelo cadastro da empresa.');
}

/** Lê os dados de um .pfx sem guardá-lo (para cadastrar o vencimento sem digitar). */
export function lerDadosPfx(pfx, senha) {
  let info;
  try { info = lerCertificado(pfx, senha); } catch (e) { throw invalido(e.message); }
  const doc = info.documento || '';
  return {
    titular: info.titular, documento: doc, emissor: info.emissor,
    vencimento: new Date(new Date(info.validoAte).getTime() - 3 * 3600e3).toISOString().slice(0, 10),
    tipo: doc.length === 11 ? 'e-CPF A1' : 'e-CNPJ A1',
  };
}

/** Mantém na carteira o certificado instalado numa empresa emitente. */
export async function sincronizarDoPrestador(contaId, prestadorId, meta, razaoSocial) {
  const venc = new Date(new Date(meta.validoAte).getTime() - 3 * 3600e3).toISOString().slice(0, 10);
  await q(`INSERT INTO certificados (conta_id, prestador_id, titular, documento, emissor, vencimento)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (prestador_id) WHERE prestador_id IS NOT NULL DO UPDATE SET titular = EXCLUDED.titular, documento = EXCLUDED.documento,
      emissor = EXCLUDED.emissor,
      avisos_enviados = CASE WHEN certificados.vencimento <> EXCLUDED.vencimento THEN '{}' ELSE certificados.avisos_enviados END,
      vencimento = EXCLUDED.vencimento, atualizado_em = now()`,
  [contaId, prestadorId, meta.titular || razaoSocial, meta.documento || null, meta.emissor || null, venc]);
}

// ------------------------------------------------------------------ venda (link público)

const slugDe = (nome) => String(nome).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'conta';

export async function configVenda(contaId) {
  let c = await um('SELECT id, nome, slug, venda_certificados FROM contas WHERE id = $1', [contaId]);
  if (!c.slug) {
    const base = slugDe(c.nome);
    for (let i = 0; i < 20 && !c.slug; i++) {
      const tentativa = i ? `${base}-${i + 1}` : base;
      c = (await um('UPDATE contas SET slug = $2 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM contas WHERE slug = $2) RETURNING id, nome, slug, venda_certificados', [contaId, tentativa])) || c;
    }
  }
  const v = c.venda_certificados || {};
  return {
    slug: c.slug, link: `${config.urlApp}/certificado.html?c=${c.slug}`,
    ativo: v.ativo !== false, linkCompra: v.linkCompra || '', whatsapp: v.whatsapp || '', emailAvisos: v.emailAvisos || '',
    mensagem: v.mensagem || '', precos: v.precos || {},
  };
}

export async function salvarConfigVenda(contaId, d) {
  if (d.slug !== undefined && !/^[a-z0-9-]{3,40}$/.test(d.slug)) throw invalido('O endereço do link deve ter de 3 a 40 letras minúsculas, números ou hífens.');
  if (d.linkCompra && !/^https:\/\//.test(d.linkCompra)) throw invalido('O link de compra deve começar com https://');
  const v = { ativo: d.ativo !== false, linkCompra: d.linkCompra || '', whatsapp: (d.whatsapp || '').replace(/\D/g, ''), emailAvisos: d.emailAvisos || '',
    mensagem: String(d.mensagem || '').slice(0, 500), precos: d.precos || {} };
  try {
    await q('UPDATE contas SET venda_certificados = $2, slug = coalesce($3, slug) WHERE id = $1', [contaId, v, d.slug || null]);
  } catch (e) {
    if (e.code === '23505') throw new ErroApp(409, 'Este endereço já está em uso. Escolha outro.');
    throw e;
  }
  return configVenda(contaId);
}

export async function paginaPublica(slug) {
  const c = await um('SELECT id, nome, venda_certificados FROM contas WHERE slug = $1 AND status = $2', [slug, 'ativa']);
  const v = c?.venda_certificados || {};
  if (!c || v.ativo === false) throw naoEncontrado('Página');
  return { nome: c.nome, tipos: TIPOS.filter((t) => t !== 'Outro'), mensagem: v.mensagem || '', whatsapp: v.whatsapp || '', precos: v.precos || {} };
}

const STATUS = ['novo', 'em_atendimento', 'aguardando_pagamento', 'aguardando_validacao', 'emitido', 'cancelado'];

export async function criarPedido(slug, d, ip) {
  if (d.site) throw invalido('Pedido inválido.'); // campo-isca contra robôs
  const c = await um('SELECT id, nome, venda_certificados FROM contas WHERE slug = $1 AND status = $2', [slug, 'ativa']);
  const v = c?.venda_certificados || {};
  if (!c || v.ativo === false) throw naoEncontrado('Página');

  const tipo = TIPOS.includes(d.tipo) ? d.tipo : null;
  if (!tipo) throw invalido('Escolha o tipo de certificado.');
  const pj = tipo.startsWith('e-CNPJ') || tipo.startsWith('NF-e');
  const erros = [];
  if (!d.nome?.trim()) erros.push({ campo: 'nome', mensagem: 'Informe o nome do responsável.' });
  if (!cpfValido(d.cpf)) erros.push({ campo: 'cpf', mensagem: 'CPF do responsável inválido.' });
  if (pj && !documentoValido(d.cnpj)) erros.push({ campo: 'cnpj', mensagem: 'CNPJ inválido.' });
  if (pj && !d.razaoSocial?.trim()) erros.push({ campo: 'razaoSocial', mensagem: 'Informe a razão social.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email || '')) erros.push({ campo: 'email', mensagem: 'E-mail inválido.' });
  if (String(d.telefone || '').replace(/\D/g, '').length < 10) erros.push({ campo: 'telefone', mensagem: 'Informe um telefone com DDD.' });
  if (!d.aceite) erros.push({ campo: 'aceite', mensagem: 'É preciso autorizar o uso dos dados para a emissão do certificado.' });
  if (erros.length) throw invalido(erros.map((e) => e.mensagem).join(' '), erros);

  const dados = {
    nome: d.nome.trim(), cpf: normDoc(d.cpf), nascimento: d.nascimento || null, email: d.email.trim(), telefone: d.telefone,
    razaoSocial: pj ? d.razaoSocial.trim() : null, cnpj: pj ? normDoc(d.cnpj) : null,
    cep: d.cep || null, cidade: d.cidade || null, uf: d.uf || null,
    validacao: ['video', 'presencial'].includes(d.validacao) ? d.validacao : 'video', horario: d.horario || null,
    observacao: String(d.observacao || '').slice(0, 1000), aceiteEm: new Date().toISOString(),
  };
  const p = await um(`INSERT INTO pedidos_certificado (conta_id, tipo, dados, renovacao, ip, historico)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, numero, criado_em`,
  [c.id, tipo, dados, !!d.renovacao, ip, JSON.stringify([{ em: new Date().toISOString(), status: 'novo' }])]);

  const destino = v.emailAvisos || (await um(`SELECT u.email FROM membros m JOIN usuarios u ON u.id = m.usuario_id WHERE m.conta_id = $1 AND m.papel = 'dono'`, [c.id]))?.email;
  if (destino) await enviarEmail({
    para: destino, assunto: `Novo pedido de certificado nº ${p.numero}: ${tipo}`, titulo: `Pedido nº ${p.numero}`,
    corpo: `<p><b>${esc(dados.razaoSocial || dados.nome)}</b> pediu um certificado <b>${esc(tipo)}</b>${d.renovacao ? ' (renovação)' : ''}.</p>
      <p>Contato: ${esc(dados.nome)}, ${esc(dados.telefone)}, ${esc(dados.email)}</p>`,
    botao: { texto: 'Ver pedido', url: `${config.urlApp}/app.html#/certificados/pedidos` },
  }).catch(() => {});
  await disparar(c.id, 'pedido_certificado.criado', { numero: p.numero, tipo, ...dados }).catch(() => {});
  return { numero: p.numero, linkCompra: v.linkCompra || null, whatsapp: v.whatsapp || null };
}

export async function listarPedidos(contaId, { status } = {}) {
  return varios(`SELECT id, numero, status, tipo, dados, renovacao, historico, criado_em, atualizado_em FROM pedidos_certificado
    WHERE conta_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY criado_em DESC LIMIT 300`, [contaId, status || null]);
}

export async function alterarPedido(contaId, id, { status }, quem) {
  if (!STATUS.includes(status)) throw invalido('Situação inválida.');
  const r = await um(`UPDATE pedidos_certificado SET status = $3, atualizado_em = now(),
      historico = historico || jsonb_build_array(jsonb_build_object('em', now(), 'status', $3::text, 'por', $4::text))
      WHERE id = $1 AND conta_id = $2 RETURNING id`, [id, contaId, status, quem.usuario?.nome || 'API']);
  if (!r) throw naoEncontrado('Pedido');
}

// ------------------------------------------------------------------ avisos de vencimento

/** Envia os avisos de vencimento devidos (30, 15, 7, 1 dia e no dia). Seguro para rodar várias vezes. */
export async function enviarAvisosVencimento() {
  const pendentes = await varios(`SELECT c.*, (c.vencimento - (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS dias,
      ct.nome AS conta_nome, ct.slug, ct.venda_certificados, p.razao_social AS empresa
    FROM certificados c JOIN contas ct ON ct.id = c.conta_id LEFT JOIN prestadores p ON p.id = c.prestador_id
    WHERE ct.status = 'ativa' AND c.vencimento BETWEEN (now() AT TIME ZONE 'America/Sao_Paulo')::date AND (now() AT TIME ZONE 'America/Sao_Paulo')::date + 30`);
  let enviados = 0;
  for (const c of pendentes) {
    const devidos = MARCOS.filter((m) => c.dias <= m && !c.avisos_enviados.includes(m));
    if (!devidos.length) continue;
    const marco = Math.min(...devidos);
    // Marca todos os marcos já ultrapassados de uma vez (evita rajada de e-mails).
    const r = await q(`UPDATE certificados SET avisos_enviados = avisos_enviados || $2::int[] WHERE id = $1 AND NOT (avisos_enviados && $2::int[])`, [c.id, devidos]);
    if (!r.rowCount) continue;
    const quando = c.dias === 0 ? 'vence hoje' : c.dias === 1 ? 'vence amanhã' : `vence em ${c.dias} dias`;
    const venc = new Date(c.vencimento + 'T12:00:00').toLocaleDateString('pt-BR');
    const equipe = await varios(`SELECT u.email FROM membros m JOIN usuarios u ON u.id = m.usuario_id WHERE m.conta_id = $1 AND m.papel IN ('dono', 'admin')`, [c.conta_id]);
    for (const { email } of equipe) {
      await enviarEmail({
        para: email, assunto: `Certificado de ${c.titular} ${quando}`, titulo: `Certificado ${quando}`,
        corpo: `<p>O certificado <b>${esc(c.tipo)}</b> de <b>${esc(c.titular)}</b>${c.empresa ? ` (empresa emitente ${esc(c.empresa)})` : ''} vence em <b>${venc}</b>.</p>
          ${c.prestador_id ? '<p>Sem certificado válido, a emissão de notas dessa empresa para.</p>' : ''}
          ${c.cliente_nome || c.cliente_telefone ? `<p>Cliente: ${esc(c.cliente_nome || '')} ${esc(c.cliente_telefone || '')} ${esc(c.cliente_email || '')}</p>` : ''}`,
        botao: { texto: 'Ver certificados', url: `${config.urlApp}/app.html#/certificados` },
      }).catch(() => {});
    }
    if (c.avisar_cliente && c.cliente_email && c.slug && c.venda_certificados?.ativo !== false) {
      await enviarEmail({
        para: c.cliente_email, assunto: `Seu certificado digital ${quando}`, titulo: `Seu certificado digital ${quando}`,
        corpo: `<p>Olá${c.cliente_nome ? ', ' + esc(c.cliente_nome.split(' ')[0]) : ''}. O certificado <b>${esc(c.tipo)}</b> de <b>${esc(c.titular)}</b> vence em <b>${venc}</b>.
          Sem ele você fica impedido de emitir notas e acessar sistemas do governo.</p><p>Renove agora com ${esc(c.conta_nome)}:</p>`,
        botao: { texto: 'Renovar meu certificado', url: `${config.urlApp}/certificado.html?c=${c.slug}&renovacao=1&tipo=${encodeURIComponent(c.tipo)}` },
      }).catch(() => {});
    }
    await disparar(c.conta_id, 'certificado.vencendo', { titular: c.titular, documento: c.documento, tipo: c.tipo, vencimento: c.vencimento, dias: c.dias, marco }).catch(() => {});
    enviados++;
  }
  return { enviados };
}

export function iniciarRotinaCertificados() {
  const rodar = () => enviarAvisosVencimento().catch((e) => console.error('[certificados]', e.message));
  setTimeout(rodar, 90_000).unref();
  return setInterval(rodar, 3600_000).unref();
}
