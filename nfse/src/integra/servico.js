import fs from 'node:fs';
import { q, um, varios } from '../db/pool.js';
import { config } from '../config.js';
import { ErroApp, invalido, naoEncontrado, proibido } from '../saas/erros.js';
import { situacaoConta } from '../saas/contas.js';
import { auditar } from '../saas/auditoria.js';
import { enviarEmail } from '../saas/email.js';
import { lerCertificado, certificadoVencido } from '../core/certificado.js';
import { documentoValido } from '../core/validacao.js';
import { cifrar, decifrar, novaChaveDados, abrirChaveDados } from '../util/segredo.js';
import { normDoc } from '../util/xml.js';
import { criarCliente, extrairPdfs, semPdfs, ErroIntegra } from './cliente.js';
import { servico, montarDados, CATEGORIA_CUSTO, PRECO_FAIXA1, catalogoPublico } from './catalogo.js';

const env = process.env;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------------ certificados guardados (envelope)

function guardarCert(pfx, senha) {
  let info;
  try { info = lerCertificado(pfx, senha); } catch (e) { throw invalido(e.message); }
  if (certificadoVencido(info)) throw invalido(`Certificado vencido em ${info.validoAte.slice(0, 10)}.`);
  const { dek, dekCifrada } = novaChaveDados();
  return { pfx: cifrar(pfx, dek), senha: cifrar(senha, dek), chave: dekCifrada,
    meta: { titular: info.titular, documento: info.documento, validoAte: info.validoAte, emissor: info.emissor } };
}
function abrirCert(c) {
  if (!c?.pfx) return null;
  const dek = abrirChaveDados(c.chave);
  return lerCertificado(decifrar(c.pfx, dek), decifrar(c.senha, dek).toString('utf8'));
}

// ------------------------------------------------------------------ configuração da plataforma (contratante)

async function configBruta() {
  return (await um(`SELECT valor FROM plataforma_config WHERE chave = 'integra'`))?.valor || {};
}

export async function configPublica() {
  const c = await configBruta();
  return {
    ambiente: c.ambiente || env.INTEGRA_AMBIENTE || 'trial',
    contratante: c.contratante || (env.INTEGRA_CONTRATANTE_CNPJ ? { documento: env.INTEGRA_CONTRATANTE_CNPJ, nome: env.INTEGRA_CONTRATANTE_NOME || '' } : null),
    temChaves: !!(c.consumerKey || env.INTEGRA_CONSUMER_KEY),
    certificado: c.cert?.meta || (env.INTEGRA_CERT_PATH ? { origem: 'arquivo do servidor' } : null),
  };
}

export async function salvarConfig(d, quem) {
  const atual = await configBruta();
  const novo = { ...atual };
  if (d.ambiente) {
    if (!['trial', 'producao'].includes(d.ambiente)) throw invalido('Ambiente inválido.');
    novo.ambiente = d.ambiente;
  }
  if (d.contratanteDocumento !== undefined) {
    if (!documentoValido(d.contratanteDocumento)) throw invalido('CNPJ do contratante inválido.');
    novo.contratante = { documento: normDoc(d.contratanteDocumento), nome: d.contratanteNome || '' };
  }
  const { dek, dekCifrada } = novaChaveDados();
  if (d.consumerKey && d.consumerSecret) novo.chaves = { key: cifrar(d.consumerKey.trim(), dek), secret: cifrar(d.consumerSecret.trim(), dek), chave: dekCifrada };
  if (d.pfxBase64) {
    const cert = guardarCert(Buffer.from(d.pfxBase64, 'base64'), d.senha || '');
    if (novo.contratante?.documento && normDoc(cert.meta.documento).slice(0, 8) !== normDoc(novo.contratante.documento).slice(0, 8))
      throw invalido('O certificado não pertence ao CNPJ do contratante.');
    novo.cert = cert;
  }
  novo.consumerKey = !!novo.chaves;
  await q(`INSERT INTO plataforma_config (chave, valor) VALUES ('integra', $1) ON CONFLICT (chave) DO UPDATE SET valor = $1, atualizado_em = now()`, [novo]);
  clienteCache = null;
  await auditar(quem, 'integra.configurar', 'plataforma', { ambiente: novo.ambiente });
  return configPublica();
}

let clienteCache = null;
async function cliente() {
  if (clienteCache && clienteCache.expira > Date.now()) return clienteCache.c;
  const c = await configBruta();
  const ambiente = c.ambiente || env.INTEGRA_AMBIENTE || 'trial';
  let consumerKey = env.INTEGRA_CONSUMER_KEY, consumerSecret = env.INTEGRA_CONSUMER_SECRET;
  if (c.chaves) {
    const dek = abrirChaveDados(c.chaves.chave);
    consumerKey = decifrar(c.chaves.key, dek).toString('utf8');
    consumerSecret = decifrar(c.chaves.secret, dek).toString('utf8');
  }
  let cert = c.cert ? abrirCert(c.cert) : null;
  if (!cert && env.INTEGRA_CERT_PATH) cert = lerCertificado(fs.readFileSync(env.INTEGRA_CERT_PATH), env.INTEGRA_CERT_SENHA || '');
  const contratante = c.contratante || { documento: env.INTEGRA_CONTRATANTE_CNPJ || '00000000000000', nome: env.INTEGRA_CONTRATANTE_NOME || 'CONTRATANTE' };
  const urls = env.INTEGRA_URL ? { api: env.INTEGRA_URL, auth: env.INTEGRA_URL_AUTH || env.INTEGRA_URL + '/authenticate' } : undefined;
  const cl = criarCliente({ ambiente, consumerKey, consumerSecret, contratante, cert, urls });
  clienteCache = { c: cl, expira: Date.now() + 5 * 60_000, contratante, ambiente };
  return cl;
}

// ------------------------------------------------------------------ escritório da conta (procurador)

export async function procuradorDaConta(contaId) {
  const c = await um('SELECT integra FROM contas WHERE id = $1', [contaId]);
  const i = c?.integra || {};
  return { usarContratante: !!i.usarContratante, documento: i.documento || null, nome: i.nome || null, certificado: i.cert?.meta || null,
    diaDas: i.diaDas || 5, lembreteDias: i.lembreteDias ?? 3 };
}

export async function salvarProcurador(contaId, d) {
  const atual = (await um('SELECT integra FROM contas WHERE id = $1', [contaId])).integra || {};
  const novo = { ...atual };
  if (d.diaDas !== undefined) {
    const dia = Number(d.diaDas);
    if (!Number.isInteger(dia) || dia < 1 || dia > 19) throw invalido('Dia de geração do DAS deve ser entre 1 e 19.');
    novo.diaDas = dia;
  }
  if (d.lembreteDias !== undefined) novo.lembreteDias = Math.max(0, Math.min(10, Number(d.lembreteDias) || 0));
  if (d.pfxBase64) {
    const cert = guardarCert(Buffer.from(d.pfxBase64, 'base64'), d.senha || '');
    if (cert.meta.documento?.length !== 14) throw invalido('Use o e-CNPJ do escritório (procurador).');
    novo.cert = cert;
    novo.documento = cert.meta.documento;
    novo.nome = d.nome || cert.meta.titular;
    delete novo.token; delete novo.tokenExpira;
  }
  await q('UPDATE contas SET integra = $2 WHERE id = $1', [contaId, novo]);
  return procuradorDaConta(contaId);
}

/** Só o administrador da plataforma marca uma conta como "própria" (usa o contratante como autor). */
export async function definirContaPropria(contaId, sim) {
  await q(`UPDATE contas SET integra = integra || jsonb_build_object('usarContratante', $2::boolean) WHERE id = $1`, [contaId, !!sim]);
}

async function autorDaConta(contaId, cl) {
  const c = await um('SELECT integra FROM contas WHERE id = $1', [contaId]);
  const i = c.integra || {};
  if (i.usarContratante) return {};
  if (!i.cert?.pfx) {
    if (cl.ambiente !== 'producao') return {}; // no trial qualquer conta pode testar
    throw new ErroApp(422, 'Configure o certificado e-CNPJ do seu escritório (procurador) em Fiscal > Configuração antes de usar o Integra Contador.');
  }
  if (i.token && i.tokenExpira > Date.now() + 5 * 60_000) return { autor: i.documento, tokenProcurador: i.token };
  const r = await cl.autenticarProcurador({ procurador: { documento: i.documento, nome: i.nome }, certProcurador: abrirCert(i.cert) });
  await q(`UPDATE contas SET integra = integra || jsonb_build_object('token', $2::text, 'tokenExpira', $3::bigint) WHERE id = $1`, [contaId, r.token, r.expira]);
  return { autor: i.documento, tokenProcurador: r.token };
}

// ------------------------------------------------------------------ contribuintes

const deContrib = (r) => r && ({ id: r.id, documento: r.documento, nome: r.nome, regime: r.regime, email: r.email, telefone: r.telefone,
  dasAutomatico: r.das_automatico, observacao: r.observacao, criadoEm: r.criado_em });

export async function listarContribuintes(contaId, { busca, regime } = {}) {
  return (await varios(`SELECT * FROM contribuintes WHERE conta_id = $1 AND ativo
    AND ($2::text IS NULL OR nome ILIKE '%' || $2 || '%' OR documento LIKE '%' || regexp_replace($2, '\\D', '', 'g') || '%')
    AND ($3::text IS NULL OR regime = $3) ORDER BY nome`, [contaId, busca || null, regime || null])).map(deContrib);
}

export async function salvarContribuinte(contaId, d) {
  const doc = normDoc(d.documento);
  if (!documentoValido(doc)) throw invalido('CPF/CNPJ inválido.');
  if (!d.nome?.trim()) throw invalido('Informe o nome.');
  const regime = ['MEI', 'SN', 'LP', 'LR', 'PF', 'Outro'].includes(d.regime) ? d.regime : 'MEI';
  if (d.dasAutomatico && regime !== 'MEI') throw invalido('O DAS automático é só para MEI.');
  if (d.dasAutomatico && !d.email) throw invalido('Para enviar o DAS automaticamente, informe o e-mail do cliente.');
  const v = [doc, d.nome.trim(), regime, d.email || null, d.telefone || null, !!d.dasAutomatico, d.observacao || null];
  try {
    if (d.id) {
      const r = await um(`UPDATE contribuintes SET documento = $3, nome = $4, regime = $5, email = $6, telefone = $7, das_automatico = $8, observacao = $9,
        atualizado_em = now() WHERE id = $1 AND conta_id = $2 AND ativo RETURNING *`, [d.id, contaId, ...v]);
      if (!r) throw naoEncontrado('Contribuinte');
      return deContrib(r);
    }
    return deContrib(await um(`INSERT INTO contribuintes (conta_id, documento, nome, regime, email, telefone, das_automatico, observacao)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [contaId, ...v]));
  } catch (e) {
    if (e.code === '23505') throw new ErroApp(409, 'Este CPF/CNPJ já está na sua carteira.');
    throw e;
  }
}

export async function removerContribuinte(contaId, id) {
  await q('UPDATE contribuintes SET ativo = false WHERE id = $1 AND conta_id = $2', [id, contaId]);
}

/** Importa linhas "CNPJ;Nome;E-mail;Regime" (vírgula ou ponto e vírgula). */
export async function importarContribuintes(contaId, texto) {
  const res = { criados: 0, ignorados: [] };
  for (const [i, linha] of String(texto || '').split(/\r?\n/).entries()) {
    if (!linha.trim()) continue;
    const [doc, nome, email, regime] = linha.split(/[;,\t]/).map((x) => x?.trim());
    try {
      await salvarContribuinte(contaId, { documento: doc, nome: nome || doc, email: email || null, regime: (regime || 'MEI').toUpperCase() });
      res.criados++;
    } catch (e) { res.ignorados.push({ linha: i + 1, motivo: e.message }); }
  }
  return res;
}

// ------------------------------------------------------------------ execução de serviços

export async function usoDoMes(contaId) {
  const r = await um(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE categoria = 'consulta')::int AS consulta,
      count(*) FILTER (WHERE categoria = 'emissao')::int AS emissao,
      count(*) FILTER (WHERE categoria = 'declaracao')::int AS declaracao
    FROM integra_chamadas WHERE conta_id = $1 AND ambiente = 'producao'
      AND criado_em >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`, [contaId]);
  return { ...r, custoEstimado: +(r.consulta * PRECO_FAIXA1.consulta + r.emissao * PRECO_FAIXA1.emissao + r.declaracao * PRECO_FAIXA1.declaracao).toFixed(2) };
}

/**
 * Executa um serviço do catálogo para um contribuinte.
 * @returns {{sucesso, mensagens, dados, documentos, chamadaId}}
 */
export async function executar(quem, { codigo, contribuinte, valores, json, origem = 'manual' }) {
  const s = servico(codigo);
  if (!s || s.interno) throw invalido('Serviço desconhecido.');
  const doc = normDoc(contribuinte);
  if (!documentoValido(doc)) throw invalido('CPF/CNPJ do contribuinte inválido.');
  const cl = await cliente();
  const sit = await situacaoConta(quem.contaId);
  if (sit.status !== 'ativa') throw new ErroApp(403, 'Conta suspensa.');
  if (cl.ambiente === 'producao') {
    const uso = await usoDoMes(quem.contaId);
    const limite = sit.limites.fiscalMes ?? 0;
    if (uso.total >= limite) throw new ErroApp(402, `Limite de ${limite} consultas fiscais/mês do plano ${sit.nomePlano} atingido. Faça upgrade para continuar.`);
  }
  if (s.composto === 'sitfis') return executarSitfis(quem, s, doc, cl, origem);

  let dados;
  if (s.composto === 'procuracao') {
    const proc = await procuradorDaConta(quem.contaId);
    const outorgado = proc.documento || clienteCache?.contratante?.documento;
    dados = JSON.stringify({ outorgante: doc, tipoOutorgante: doc.length === 11 ? '1' : '2', outorgado, tipoOutorgado: outorgado?.length === 11 ? '1' : '2' });
  } else {
    try { dados = montarDados(s, valores, json); } catch (e) { throw invalido(e.message); }
  }
  return chamar(quem, s, doc, dados, cl, origem);
}

async function chamar(quem, s, doc, dados, cl, origem) {
  let r, erro;
  try {
    const autor = await autorDaConta(quem.contaId, cl);
    r = await cl.executar(s, doc, dados, autor);
  } catch (e) {
    if (e instanceof ErroApp) throw e;
    erro = e;
  }
  const mensagens = r?.mensagens || (erro ? [{ codigo: 'FALHA', texto: erro.message }] : []);
  const chamada = await um(`INSERT INTO integra_chamadas (conta_id, usuario_id, chave_api_id, contribuinte, codigo, tipo, categoria, ambiente, sucesso, status_http,
      mensagens, resposta, ms, origem) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
  [quem.contaId, quem.usuarioId || null, quem.chaveApiId || null, doc, s.codigo, s.tipo, CATEGORIA_CUSTO[s.tipo], cl.ambiente, !!r?.sucesso,
    r?.status || null, JSON.stringify(mensagens), JSON.stringify(semPdfs(r?.dados)), r?.ms || null, origem]);
  if (erro) throw new ErroApp(erro.status && erro.status < 500 ? erro.status : 502, erro.message, { erros: mensagens.map((m) => ({ mensagem: m.texto })) });

  const documentos = [];
  if (r.sucesso) {
    for (const [i, pdf] of extrairPdfs(r.dados).entries()) {
      const nome = `${s.servico.replace(/\d+$/, '').toLowerCase()}-${doc}${i ? '-' + (i + 1) : ''}.pdf`;
      const d = await um(`INSERT INTO documentos_fiscais (conta_id, contribuinte, chamada_id, codigo, descricao, nome_arquivo, conteudo)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, nome_arquivo`, [quem.contaId, doc, chamada.id, s.codigo, s.nome, nome, Buffer.from(pdf.base64, 'base64')]);
      documentos.push({ id: d.id, nome: d.nome_arquivo });
    }
  }
  await auditar(quem, 'integra.executar', s.codigo, { contribuinte: doc, sucesso: r.sucesso });
  return { sucesso: r.sucesso, mensagens, dados: semPdfs(r.dados), documentos, chamadaId: chamada.id, ambiente: cl.ambiente };
}

async function executarSitfis(quem, s, doc, cl, origem) {
  const pedido = { sistema: 'SITFIS', servico: 'SOLICITARPROTOCOLO91', versao: '1.0', tipo: 'Apoiar', codigo: 'SITFIS.SOLICITARPROTOCOLO91', nome: 'Protocolo situação fiscal' };
  const p = await chamar(quem, pedido, doc, '', cl, origem);
  const protocolo = p.dados?.protocoloRelatorio;
  if (!protocolo) return p;
  let espera = Math.min(Number(p.dados?.tempoEspera || 0), 15_000);
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    if (espera) await new Promise((ok) => setTimeout(ok, espera));
    const r = await chamar(quem, s, doc, JSON.stringify({ protocoloRelatorio: protocolo }), cl, origem);
    if (r.documentos.length || !r.dados?.tempoEspera) return r;
    espera = Math.min(Number(r.dados.tempoEspera), 15_000);
  }
  return { sucesso: false, mensagens: [{ codigo: 'AGUARDE', texto: `O relatório ainda está sendo preparado. Protocolo ${protocolo}: tente novamente em alguns minutos.` }], dados: { protocoloRelatorio: protocolo }, documentos: [] };
}

// ------------------------------------------------------------------ histórico e documentos

export async function historico(contaId, { limite = 100, contribuinte } = {}) {
  return varios(`SELECT c.id, c.contribuinte, c.codigo, c.tipo, c.categoria, c.ambiente, c.sucesso, c.mensagens, c.ms, c.origem, c.criado_em,
      u.nome AS usuario, (SELECT json_agg(json_build_object('id', d.id, 'nome', d.nome_arquivo)) FROM documentos_fiscais d WHERE d.chamada_id = c.id) AS documentos
    FROM integra_chamadas c LEFT JOIN usuarios u ON u.id = c.usuario_id
    WHERE c.conta_id = $1 AND ($3::text IS NULL OR c.contribuinte = $3) ORDER BY c.id DESC LIMIT $2`,
  [contaId, Math.min(Number(limite) || 100, 500), contribuinte ? normDoc(contribuinte) : null]);
}

export async function respostaDaChamada(contaId, id) {
  const r = await um('SELECT resposta, mensagens, codigo, contribuinte, criado_em FROM integra_chamadas WHERE id = $1 AND conta_id = $2', [id, contaId]);
  if (!r) throw naoEncontrado('Consulta');
  return r;
}

export async function documento(contaId, id) {
  const d = await um('SELECT nome_arquivo, conteudo FROM documentos_fiscais WHERE id = $1 AND conta_id = $2', [id, contaId]);
  if (!d) throw naoEncontrado('Documento');
  return d;
}

// ------------------------------------------------------------------ DAS do MEI

const competenciaAnterior = (agora = new Date()) => {
  const d = new Date(agora.getTime() - 3 * 3600e3);
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const fmtComp = (c) => `${c.slice(4)}/${c.slice(0, 4)}`;
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function detalheDas(dados) {
  const item = Array.isArray(dados) ? dados[0] : dados;
  const det = (item?.detalhamento || [])[0] || {};
  const venc = String(det.dataVencimento || '').replace(/\D/g, '');
  const cb = det.codigoDeBarras;
  return {
    valor: det.valores?.total ?? det.valorTotal ?? null,
    vencimento: venc.length === 8 ? `${venc.slice(0, 4)}-${venc.slice(4, 6)}-${venc.slice(6)}` : null,
    codigoBarras: Array.isArray(cb) ? cb.join(' ') : cb || null,
  };
}

export async function listarDasMei(contaId, competencia) {
  const comp = competencia || competenciaAnterior();
  return {
    competencia: comp,
    itens: await varios(`SELECT c.id AS contribuinte_id, c.nome, c.documento, c.email, c.das_automatico, d.id, d.status, d.valor, d.vencimento,
        d.codigo_barras, d.documento_id, d.erro, d.enviado_em, d.lembrete_em, d.pago_em
      FROM contribuintes c LEFT JOIN das_mei d ON d.contribuinte_id = c.id AND d.competencia = $2
      WHERE c.conta_id = $1 AND c.ativo AND c.regime = 'MEI' ORDER BY c.nome`, [contaId, comp]),
  };
}

/** Gera (ou regera) o DAS do MEI e, se houver e-mail, envia ao cliente. */
export async function gerarDasMei(quem, contribuinteId, competencia, { enviar = true, origem = 'manual' } = {}) {
  const c = await um('SELECT * FROM contribuintes WHERE id = $1 AND conta_id = $2 AND ativo', [contribuinteId, quem.contaId]);
  if (!c) throw naoEncontrado('Contribuinte');
  if (c.regime !== 'MEI') throw invalido('Este contribuinte não é MEI.');
  const comp = competencia || competenciaAnterior();
  if (!/^\d{6}$/.test(comp)) throw invalido('Competência inválida (AAAAMM).');
  let r;
  try {
    r = await executar(quem, { codigo: 'PGMEI.GERARDASPDF21', contribuinte: c.documento, valores: { periodoApuracao: comp }, origem });
  } catch (e) {
    await q(`INSERT INTO das_mei (conta_id, contribuinte_id, competencia, status, erro) VALUES ($1, $2, $3, 'erro', $4)
      ON CONFLICT (contribuinte_id, competencia) DO UPDATE SET status = CASE WHEN das_mei.status = 'pago' THEN 'pago' ELSE 'erro' END, erro = $4, atualizado_em = now()`,
    [quem.contaId, c.id, comp, e.message]);
    throw e;
  }
  if (!r.sucesso || !r.documentos.length) {
    const msg = r.mensagens.map((m) => m.texto).join(' ') || 'O SERPRO não devolveu a guia.';
    await q(`INSERT INTO das_mei (conta_id, contribuinte_id, competencia, status, erro) VALUES ($1, $2, $3, 'erro', $4)
      ON CONFLICT (contribuinte_id, competencia) DO UPDATE SET status = CASE WHEN das_mei.status = 'pago' THEN 'pago' ELSE 'erro' END, erro = $4, atualizado_em = now()`,
    [quem.contaId, c.id, comp, msg]);
    return { sucesso: false, mensagens: r.mensagens };
  }
  const det = detalheDas(r.dados);
  const das = await um(`INSERT INTO das_mei (conta_id, contribuinte_id, competencia, status, valor, vencimento, codigo_barras, documento_id)
    VALUES ($1, $2, $3, 'gerado', $4, $5, $6, $7)
    ON CONFLICT (contribuinte_id, competencia) DO UPDATE SET status = CASE WHEN das_mei.status = 'pago' THEN 'pago' ELSE 'gerado' END,
      valor = $4, vencimento = $5, codigo_barras = $6, documento_id = $7, erro = NULL, atualizado_em = now() RETURNING *`,
  [quem.contaId, c.id, comp, det.valor, det.vencimento, det.codigoBarras, r.documentos[0].id]);
  if (enviar && c.email && das.status !== 'pago') await enviarDas(quem.contaId, das.id);
  return { sucesso: true, das: await um('SELECT * FROM das_mei WHERE id = $1', [das.id]) };
}

export async function enviarDas(contaId, dasId, { lembrete = false } = {}) {
  const d = await um(`SELECT d.*, c.nome, c.email, c.documento, ct.nome AS escritorio, f.conteudo, f.nome_arquivo
    FROM das_mei d JOIN contribuintes c ON c.id = d.contribuinte_id JOIN contas ct ON ct.id = d.conta_id
    LEFT JOIN documentos_fiscais f ON f.id = d.documento_id WHERE d.id = $1 AND d.conta_id = $2`, [dasId, contaId]);
  if (!d) throw naoEncontrado('DAS');
  if (!d.email) throw invalido('O cliente não tem e-mail cadastrado.');
  if (!d.conteudo) throw invalido('Gere o DAS antes de enviar.');
  const venc = d.vencimento ? new Date(d.vencimento + 'T12:00:00').toLocaleDateString('pt-BR') : 'dia 20';
  await enviarEmail({
    para: d.email,
    assunto: lembrete ? `Lembrete: DAS MEI ${fmtComp(d.competencia)} vence em ${venc}` : `DAS MEI ${fmtComp(d.competencia)}: ${brl(d.valor)}, vence em ${venc}`,
    titulo: lembrete ? 'Seu DAS vence em breve' : `Seu DAS de ${fmtComp(d.competencia)}`,
    corpo: `<p>Olá, ${esc(d.nome)}.</p><p>Segue em anexo o DAS do MEI referente a <b>${fmtComp(d.competencia)}</b>, no valor de <b>${brl(d.valor)}</b>, com vencimento em <b>${venc}</b>.
      Você pode pagar pelo código de barras ou pelo Pix que estão no PDF.</p>
      ${d.codigo_barras ? `<p style="font-family:monospace;font-size:13px;background:#f2f5f3;padding:10px;border-radius:6px">${esc(d.codigo_barras)}</p>` : ''}
      <p style="color:#777;font-size:12px">Enviado por ${esc(d.escritorio)}.</p>`,
    anexos: [{ nome: d.nome_arquivo || `das-${d.competencia}.pdf`, conteudo: d.conteudo }],
  });
  await q(`UPDATE das_mei SET status = CASE WHEN status = 'gerado' THEN 'enviado' ELSE status END,
    ${lembrete ? 'lembrete_em' : 'enviado_em'} = now(), atualizado_em = now() WHERE id = $1`, [dasId]);
}

export async function marcarDasPago(contaId, dasId, pago = true) {
  const r = await q(`UPDATE das_mei SET status = CASE WHEN $3 THEN 'pago' WHEN enviado_em IS NOT NULL THEN 'enviado' ELSE 'gerado' END,
    pago_em = CASE WHEN $3 THEN now() END, atualizado_em = now() WHERE id = $1 AND conta_id = $2`, [dasId, contaId, !!pago]);
  if (!r.rowCount) throw naoEncontrado('DAS');
}

/** Rotina diária: gera e envia os DAS do mês e manda lembretes antes do vencimento. */
export async function rotinaDasMei(agora = new Date()) {
  const hojeBR = new Date(agora.getTime() - 3 * 3600e3);
  const dia = hojeBR.getUTCDate();
  const comp = competenciaAnterior(agora);
  const res = { gerados: 0, erros: 0, lembretes: 0 };
  const pendentes = await varios(`SELECT c.id, c.conta_id, coalesce((ct.integra->>'diaDas')::int, 5) AS dia_das FROM contribuintes c
    JOIN contas ct ON ct.id = c.conta_id
    WHERE c.ativo AND c.regime = 'MEI' AND c.das_automatico AND ct.status = 'ativa'
      AND NOT EXISTS (SELECT 1 FROM das_mei d WHERE d.contribuinte_id = c.id AND d.competencia = $1 AND d.status <> 'erro')`, [comp]);
  for (const p of pendentes) {
    if (dia < p.dia_das || dia > 19) continue;
    try {
      const r = await gerarDasMei({ contaId: p.conta_id, ip: 'rotina' }, p.id, comp, { origem: 'automatico' });
      r.sucesso ? res.gerados++ : res.erros++;
    } catch { res.erros++; }
  }
  const lembrar = await varios(`SELECT d.id, d.conta_id FROM das_mei d JOIN contas ct ON ct.id = d.conta_id
    WHERE d.status = 'enviado' AND d.lembrete_em IS NULL AND d.vencimento IS NOT NULL
      AND d.vencimento - (now() AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN 0 AND coalesce((ct.integra->>'lembreteDias')::int, 3)
      AND coalesce((ct.integra->>'lembreteDias')::int, 3) > 0`);
  for (const l of lembrar) {
    try { await enviarDas(l.conta_id, l.id, { lembrete: true }); res.lembretes++; } catch { /* sem e-mail ou sem PDF */ }
  }
  return res;
}

export function iniciarRotinaIntegra() {
  const rodar = () => rotinaDasMei().catch((e) => console.error('[das-mei]', e.message));
  setTimeout(rodar, 120_000).unref();
  return setInterval(rodar, 3600_000).unref();
}

// ------------------------------------------------------------------ administração

export async function consumoPlataforma() {
  return varios(`SELECT ct.id, ct.nome, (ct.integra->>'usarContratante')::boolean AS conta_propria,
      count(c.*)::int AS total,
      count(c.*) FILTER (WHERE c.categoria = 'consulta')::int AS consulta,
      count(c.*) FILTER (WHERE c.categoria = 'emissao')::int AS emissao,
      count(c.*) FILTER (WHERE c.categoria = 'declaracao')::int AS declaracao
    FROM contas ct LEFT JOIN integra_chamadas c ON c.conta_id = ct.id AND c.ambiente = 'producao'
      AND c.criado_em >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
    GROUP BY ct.id ORDER BY total DESC, ct.nome LIMIT 300`);
}

export { catalogoPublico, competenciaAnterior };
