// Cliente HTTP da API Integra Contador.
// - Produção: OAuth2 (client_credentials) com mTLS usando o e-CNPJ do CONTRATANTE.
// - Trial: ambiente público de testes do SERPRO (dados fictícios, token fixo, sem certificado).
// - Procurador: quando quem pede (autor) não é o contratante, envia o termo de
//   autorização assinado pelo procurador (AUTENTICAPROCURADOR) e usa o token devolvido.

import crypto from 'node:crypto';
import { request } from '../util/http.js';
import { assinarXml } from '../core/assinatura.js';
import { normDoc } from '../util/xml.js';

export const URLS = {
  producao: { api: 'https://gateway.apiserpro.serpro.gov.br/integra-contador/v1', auth: 'https://autenticacao.sapi.serpro.gov.br/authenticate' },
  trial: { api: 'https://gateway.apiserpro.serpro.gov.br/integra-contador-trial/v1', auth: null },
};
const TOKEN_TRIAL = '06aef429-a981-3ec5-a1f8-71d38d86481e'; // token público do ambiente de demonstração do SERPRO

export class ErroIntegra extends Error {
  constructor(mensagem, { status, mensagens, corpo } = {}) {
    super(mensagem);
    Object.assign(this, { status, mensagens: mensagens || [], corpo });
  }
}

const tipoDoc = (d) => (normDoc(d).length === 11 ? 1 : 2);

export function criarCliente(cfg) {
  // cfg: { ambiente, consumerKey, consumerSecret, contratante: { documento, nome }, cert: { keyPem, certPem } }
  const urls = { ...URLS[cfg.ambiente === 'producao' ? 'producao' : 'trial'], ...(cfg.urls || {}) };
  let token = null;

  async function autenticar() {
    if (cfg.ambiente !== 'producao') return { access_token: TOKEN_TRIAL, jwt_token: TOKEN_TRIAL, expira: Infinity };
    if (token && token.expira > Date.now() + 60_000) return token;
    if (!cfg.consumerKey || !cfg.consumerSecret || !cfg.cert) throw new ErroIntegra('Integra Contador não configurado: informe chaves e certificado do contratante.', { status: 503 });
    const r = await request(urls.auth, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString('base64'),
        'Role-Type': 'TERCEIROS', 'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials', key: cfg.cert.keyPem, cert: cfg.cert.certPem, timeout: 30_000,
    });
    let j = {};
    try { j = JSON.parse(r.body.toString('utf8')); } catch { /* corpo não JSON */ }
    if (r.status !== 200 || !j.access_token) throw new ErroIntegra(`Falha na autenticação no SERPRO (HTTP ${r.status}). Confira as chaves e o certificado.`, { status: 502 });
    token = { ...j, expira: Date.now() + Number(j.expires_in || 1800) * 1000 };
    return token;
  }

  /**
   * Executa um serviço.
   * @param {{sistema, servico, versao, tipo}} s
   * @param {string} contribuinte CPF/CNPJ
   * @param {string} dados string JSON (ou '')
   * @param {{autor?: string, tokenProcurador?: string}} [o]
   */
  async function executar(s, contribuinte, dados, o = {}) {
    const t = await autenticar();
    const autor = normDoc(o.autor || cfg.contratante.documento);
    const corpo = {
      contratante: { numero: normDoc(cfg.contratante.documento), tipo: 2 },
      autorPedidoDados: { numero: autor, tipo: tipoDoc(autor) },
      contribuinte: { numero: normDoc(contribuinte), tipo: tipoDoc(contribuinte) },
      pedidoDados: { idSistema: s.sistema, idServico: s.servico, versaoSistema: s.versao, dados: dados ?? '' },
    };
    const headers = {
      'Content-Type': 'application/json', Authorization: `Bearer ${t.access_token}`, jwt_token: t.jwt_token,
      'X-Request-Tag': crypto.randomUUID().replace(/-/g, '').slice(0, 32),
    };
    if (o.tokenProcurador) headers.autenticar_procurador_token = o.tokenProcurador;
    const inicio = Date.now();
    const r = await request(`${urls.api}/${s.tipo}`, {
      method: 'POST', headers, body: JSON.stringify(corpo),
      ...(cfg.ambiente === 'producao' ? { key: cfg.cert.keyPem, cert: cfg.cert.certPem } : {}), timeout: 90_000,
    });
    const texto = r.body.toString('utf8');
    let j = null;
    try { j = texto ? JSON.parse(texto) : {}; } catch { /* corpo não JSON */ }
    const mensagens = (j?.mensagens || []).map((m) => ({ codigo: m.codigo, texto: m.texto }));
    let dadosResp = j?.dados;
    if (typeof dadosResp === 'string' && dadosResp.trim()) {
      try { dadosResp = JSON.parse(dadosResp); } catch { /* dados em texto puro */ }
    }
    const res = { status: r.status, sucesso: r.status >= 200 && r.status < 300 && !mensagens.some((m) => /^Erro|ERRO/.test(m.codigo || '')),
      dados: dadosResp ?? null, mensagens, ms: Date.now() - inicio, headers: r.headers, corpoEnviado: corpo };
    if (r.status === 401) throw new ErroIntegra('SERPRO recusou as credenciais (HTTP 401).', { status: 502, mensagens });
    if (r.status >= 500 && !mensagens.length) throw new ErroIntegra(`SERPRO indisponível (HTTP ${r.status}). Tente novamente.`, { status: 502 });
    return res;
  }

  /** Termo de autorização do procurador (modelo oficial), assinado com o e-CNPJ do procurador. */
  function termoProcurador({ procurador, certProcurador, vigenciaDias = 365 }) {
    const hoje = new Date(Date.now() - 3 * 3600e3);
    const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const vig = new Date(hoje.getTime() + vigenciaDias * 864e5);
    const at = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const parte = (p, papel) => `numero="${normDoc(p.documento)}" nome="${at(p.nome)}" tipo="${normDoc(p.documento).length === 11 ? 'PF' : 'PJ'}" papel="${papel}"`;
    const xml = '<?xml version="1.0" encoding="UTF-8"?><termoDeAutorizacao><dados><sistema id="API Integra Contador"/>' +
      '<termo texto="Autorizo a empresa CONTRATANTE, identificada neste termo de autorização como DESTINATÁRIO, a executar as requisições dos serviços web disponibilizados pela API INTEGRA CONTADOR, onde terei o papel de AUTOR PEDIDO DE DADOS no corpo da mensagem enviada na requisição do serviço web. Esse termo de autorização está assinado digitalmente com o certificado digital do PROCURADOR ou OUTORGADO DO CONTRIBUINTE responsável, identificado como AUTOR DO PEDIDO DE DADOS."/>' +
      '<avisoLegal texto="O acesso a estas informações foi autorizado pelo próprio PROCURADOR ou OUTORGADO DO CONTRIBUINTE, responsável pela informação, via assinatura digital. É dever do destinatário da autorização e consumidor deste acesso observar a adoção de base legal para o tratamento dos dados recebidos conforme artigos 7º ou 11º da LGPD (Lei n.º 13.709, de 14 de agosto de 2018), aos direitos do titular dos dados (art. 9º, 17 e 18, da LGPD) e aos princípios que norteiam todos os tratamentos de dados no Brasil (art. 6º, da LGPD)."/>' +
      '<finalidade texto="A finalidade única e exclusiva desse TERMO DE AUTORIZAÇÃO, é garantir que o CONTRATANTE apresente a API INTEGRA CONTADOR esse consentimento do PROCURADOR ou OUTORGADO DO CONTRIBUINTE assinado digitalmente, para que possa realizar as requisições dos serviços web da API INTEGRA CONTADOR em nome do AUTOR PEDIDO DE DADOS (PROCURADOR ou OUTORGADO DO CONTRIBUINTE)."/>' +
      `<dataAssinatura data="${fmt(hoje)}"/><vigencia data="${fmt(vig)}"/>` +
      `<destinatario ${parte(cfg.contratante, 'contratante')}/><assinadoPor ${parte(procurador, 'autor pedido de dados')}/></dados></termoDeAutorizacao>`;
    // Perfil exigido pelo SERPRO: C14N 1.0, RSA-SHA256, SHA-256, Reference URI="", só o certificado folha.
    return assinarXml(xml, { cert: certProcurador, algoritmo: 'sha256' });
  }

  /** Obtém o token de procurador (válido por algumas horas; o SERPRO pode devolver 304 com o token no ETag). */
  async function autenticarProcurador({ procurador, certProcurador }) {
    const xml = termoProcurador({ procurador, certProcurador });
    const s = { sistema: 'AUTENTICAPROCURADOR', servico: 'ENVIOXMLASSINADO81', versao: '1.0', tipo: 'Apoiar' };
    const r = await executar(s, procurador.documento, JSON.stringify({ xml: Buffer.from(xml, 'utf8').toString('base64') }), { autor: procurador.documento });
    let tokenP = r.dados?.autenticar_procurador_token;
    let expira = r.dados?.data_hora_expiracao;
    if (!tokenP && r.headers?.etag) {
      const etag = String(r.headers.etag).replace(/^W\//, '').replace(/^"|"$/g, '');
      tokenP = etag.includes(':') ? etag.slice(etag.indexOf(':') + 1) : etag;
      expira = r.headers.expires ? new Date(r.headers.expires).toISOString() : null;
    }
    if (!tokenP) throw new ErroIntegra('O SERPRO não aceitou o termo de autorização do procurador.', { status: 502, mensagens: r.mensagens });
    return { token: tokenP, expira: expira ? new Date(expira).getTime() : Date.now() + 6 * 3600e3 };
  }

  return { executar, autenticarProcurador, termoProcurador, ambiente: cfg.ambiente };
}

/** Procura PDFs (Base64) em qualquer ponto da resposta. */
export function extrairPdfs(dados, caminho = '') {
  const out = [];
  const walk = (v, c) => {
    if (typeof v === 'string' && v.length > 200 && v.startsWith('JVBER')) out.push({ caminho: c, base64: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${c}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, c ? `${c}.${k}` : k);
  };
  walk(dados, caminho);
  return out;
}

/** Copia da resposta sem os PDFs (para guardar no histórico sem ocupar espaço). */
export function semPdfs(dados) {
  return JSON.parse(JSON.stringify(dados ?? null, (k, v) => (typeof v === 'string' && v.length > 200 && v.startsWith('JVBER') ? '[PDF]' : v)));
}
