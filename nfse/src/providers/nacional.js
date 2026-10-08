// NFS-e Padrão Nacional (Emissor Nacional / Sefin Nacional / ADN).
// Leiaute DPS v1.01 — API REST com mTLS. A DPS assinada é enviada compactada
// (GZip + Base64) e a NFS-e autorizada volta no mesmo formato.

import { gzipSync, gunzipSync } from 'node:zlib';
import { tag, grupo, normDoc, onlyDigits, money, dec, limparTexto, dataHoraBrasilia, hojeBrasilia } from '../util/xml.js';
import { assinarXml } from '../core/assinatura.js';
import { calcular } from '../core/calculo.js';
import { request } from '../util/http.js';
import { config } from '../config.js';

export const NS = 'http://www.sped.fazenda.gov.br/nfse';
export const VERSAO = '1.01';

export const URLS = {
  homologacao: {
    sefin: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
    adn: 'https://adn.producaorestrita.nfse.gov.br',
  },
  producao: {
    sefin: 'https://sefin.nfse.gov.br/SefinNacional',
    adn: 'https://adn.nfse.gov.br',
  },
};

export const MOTIVOS_CANCELAMENTO = {
  1: 'Erro na emissão',
  2: 'Serviço não prestado',
  9: 'Outros',
};

const gz = (s) => gzipSync(Buffer.from(s, 'utf8')).toString('base64');
const gunz = (b64) => gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');

/** "DPS" + cMun(7) + tpInsc(1: CPF, 2: CNPJ) + inscrição(14) + série(5) + nDPS(15) = 45 posições. */
export function idDps({ codigoMunicipio, documento, serie, numero }) {
  const doc = normDoc(documento);
  const tpInsc = doc.length === 11 ? '1' : '2';
  return 'DPS' + onlyDigits(codigoMunicipio).padStart(7, '0') + tpInsc + doc.padStart(14, '0') +
    onlyDigits(serie).padStart(5, '0') + onlyDigits(numero).padStart(15, '0');
}

function documentoTag(doc) {
  const d = normDoc(doc);
  return d.length === 11 ? tag('CPF', d) : tag('CNPJ', d);
}

function endereco(e) {
  if (!e || !e.logradouro) return '';
  const loc = e.pais && e.pais !== 'BR'
    ? grupo('endExt', tag('cPais', e.pais) + tag('cEndPost', e.cep || '0') + tag('xCidade', e.cidade) + tag('xEstProvReg', e.estado))
    : grupo('endNac', tag('cMun', onlyDigits(e.codigoMunicipio)) + tag('CEP', onlyDigits(e.cep)));
  return grupo('end', loc + tag('xLgr', limparTexto(e.logradouro, 255)) + tag('nro', limparTexto(e.numero || 'S/N', 60)) +
    tag('xCpl', limparTexto(e.complemento, 156)) + tag('xBairro', limparTexto(e.bairro || 'NI', 60)));
}

function tomador(t) {
  if (!t || t.tipo === 'NI') return '';
  let id;
  if (t.tipo === 'EXT') id = t.nif ? tag('NIF', t.nif) : tag('cNaoNIF', t.motivoSemNif || '0');
  else id = documentoTag(t.documento);
  return grupo('toma', id + tag('IM', t.inscricaoMunicipal) + tag('xNome', limparTexto(t.nome, 300)) +
    endereco(t.endereco) + tag('fone', onlyDigits(t.fone) || '') + tag('email', t.email));
}

function regimeTributario(p) {
  const op = Number(p.opSimpNac || 1);
  return grupo('regTrib',
    tag('opSimpNac', op) +
    (op === 3 ? tag('regApTribSN', p.regApTribSN || 1) : '') +
    tag('regEspTrib', p.regEspTrib ?? 0));
}

function ibsCbs(x) {
  if (!x || !x.cClassTrib) return '';
  const cst = String(x.cst || x.cClassTrib).slice(0, 3); // CST = 3 primeiros dígitos do cClassTrib
  return grupo('IBSCBS',
    tag('finNFSe', x.finNFSe ?? 0) +
    tag('indFinal', x.indFinal) +
    tag('cIndOp', x.cIndOp) +
    tag('indDest', x.indDest ?? 0) +
    grupo('valores', grupo('trib', grupo('gIBSCBS', tag('CST', cst) + tag('cClassTrib', x.cClassTrib))))
  );
}

/** Monta o XML (não assinado) da DPS. */
export function montarDps({ prestador: p, nota, ambiente, serie, numero, dhEmi = new Date() }) {
  const v = nota.valores || {};
  const s = nota.servico || {};
  const calc = calcular(v);
  const id = idDps({ codigoMunicipio: p.codigoMunicipio, documento: p.documento, serie, numero });
  // Pequena folga para não cair na rejeição de "data de emissão posterior ao processamento".
  const emissao = dataHoraBrasilia(new Date(dhEmi.getTime() - 60_000));
  const competencia = nota.competencia || hojeBrasilia(dhEmi);

  const prest = grupo('prest',
    documentoTag(p.documento) +
    tag('IM', p.inscricaoMunicipal) +
    tag('fone', onlyDigits(p.fone)) +
    tag('email', p.email) +
    regimeTributario(p));

  const locPrest = s.paisPrestacao && s.paisPrestacao !== 'BR'
    ? tag('cPaisPrestacao', s.paisPrestacao)
    : tag('cLocPrestacao', onlyDigits(s.municipioPrestacao || p.codigoMunicipio));

  const cTribNac = onlyDigits(s.codigoTributacaoNacional) ||
    (onlyDigits(s.itemListaServico).padStart(4, '0') + '01');

  const serv = grupo('serv',
    grupo('locPrest', locPrest) +
    grupo('cServ',
      tag('cTribNac', cTribNac) +
      tag('cTribMun', onlyDigits(s.codigoTributacaoMunicipal)) +
      tag('xDescServ', limparTexto(s.discriminacao, 2000)) +
      tag('cNBS', onlyDigits(s.codigoNbs))) +
    (s.informacoesComplementares ? grupo('infoCompl', tag('xInfComp', limparTexto(s.informacoesComplementares, 2000))) : ''));

  const descontos = (calc.descontoIncondicionado || calc.descontoCondicionado)
    ? grupo('vDescCondIncond',
      (calc.descontoIncondicionado ? tag('vDescIncond', money(calc.descontoIncondicionado)) : '') +
      (calc.descontoCondicionado ? tag('vDescCond', money(calc.descontoCondicionado)) : ''))
    : '';
  const deducoes = calc.deducoes ? grupo('vDedRed', tag('vDR', money(calc.deducoes))) : '';

  const op = Number(p.opSimpNac || 1);
  // pAliq: para não optantes a alíquota vem dos parâmetros municipais do ADN;
  // optante ME/EPP (opSimpNac=3) informa a alíquota do Anexo do Simples.
  const informarAliq = v.informarAliquota ?? (op === 3 || v.issRetido);
  const tribMun = grupo('tribMun',
    tag('tribISSQN', v.tributacaoIssqn || 1) +
    (Number(v.tributacaoIssqn) === 2 ? tag('tpImunidade', v.tipoImunidade || 0) : '') +
    tag('tpRetISSQN', v.issRetido ? (v.responsavelRetencao === 'intermediario' ? 3 : 2) : 1) +
    (informarAliq && Number(v.aliquotaIss) ? tag('pAliq', dec(v.aliquotaIss)) : ''));

  const pis = Number(v.pis || 0), cofins = Number(v.cofins || 0);
  const tribFed = grupo('tribFed',
    (pis || cofins
      ? grupo('piscofins',
        tag('CST', v.cstPisCofins || '01') +
        tag('vBCPisCofins', money(calc.baseCalculo)) +
        (v.aliquotaPis ? tag('pAliqPis', dec(v.aliquotaPis)) : '') +
        (v.aliquotaCofins ? tag('pAliqCofins', dec(v.aliquotaCofins)) : '') +
        tag('vPis', money(pis)) + tag('vCofins', money(cofins)) +
        tag('tpRetPisCofins', v.pisCofinsRetido ? 1 : 2))
      : '') +
    (Number(v.inss) ? tag('vRetCP', money(v.inss)) : '') +
    (Number(v.ir) ? tag('vRetIRRF', money(v.ir)) : '') +
    (Number(v.csll) ? tag('vRetCSLL', money(v.csll)) : ''));

  const totTrib = grupo('totTrib', op === 3 && v.percentualTributosSN
    ? tag('pTotTribSN', dec(v.percentualTributosSN))
    : tag('indTotTrib', 0));

  const valores = grupo('valores',
    grupo('vServPrest', tag('vServ', money(calc.valorServico))) +
    descontos + deducoes +
    grupo('trib', tribMun + tribFed + totTrib));

  const subst = nota.substituicao?.chave
    ? grupo('subst', tag('chSubstda', onlyDigits(nota.substituicao.chave)) + tag('cMotivo', nota.substituicao.codigoMotivo || '99') +
      tag('xMotivo', limparTexto(nota.substituicao.motivo || 'Substituicao de NFS-e', 255)))
    : '';

  const inf =
    tag('tpAmb', ambiente === 'producao' ? 1 : 2) +
    tag('dhEmi', emissao) +
    tag('verAplic', config.verAplic) +
    tag('serie', onlyDigits(serie).padStart(5, '0')) +
    tag('nDPS', String(Number(onlyDigits(numero)))) +
    tag('dCompet', competencia) +
    tag('tpEmit', 1) +
    tag('cLocEmi', onlyDigits(p.codigoMunicipio)) +
    subst + prest + tomador(nota.tomador) + serv + valores + ibsCbs(nota.ibsCbs);

  const xml = `<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="${NS}" versao="${VERSAO}"><infDPS Id="${id}">${inf}</infDPS></DPS>`;
  return { xml, id };
}

/** Pedido de registro de evento de cancelamento (e101101). */
export function montarCancelamento({ prestador, chave, ambiente, codigo, motivo, dhEvento = new Date() }) {
  const ch = onlyDigits(chave);
  const id = `PRE${ch}101101`;
  const xMotivo = limparTexto(motivo, 255);
  if (xMotivo.length < 15) throw new Error('A justificativa do cancelamento deve ter ao menos 15 caracteres.');
  const doc = normDoc(prestador.documento);
  const inf =
    tag('tpAmb', ambiente === 'producao' ? 1 : 2) +
    tag('verAplic', config.verAplic) +
    tag('dhEvento', dataHoraBrasilia(new Date(dhEvento.getTime() - 60_000))) +
    (doc.length === 11 ? tag('CPFAutor', doc) : tag('CNPJAutor', doc)) +
    tag('chNFSe', ch) +
    grupo('e101101', tag('xDesc', 'Cancelamento de NFS-e') + tag('cMotivo', codigo || 1) + tag('xMotivo', xMotivo));
  return `<?xml version="1.0" encoding="UTF-8"?><pedRegEvento xmlns="${NS}" versao="${VERSAO}"><infPedReg Id="${id}">${inf}</infPedReg></pedRegEvento>`;
}

// ---------------------------------------------------------------- respostas

function campo(obj, ...nomes) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const n of nomes) {
    const k = Object.keys(obj).find((x) => x.toLowerCase() === n.toLowerCase());
    if (k !== undefined) return obj[k];
  }
  return undefined;
}

function mensagensDe(json) {
  const lista = [].concat(campo(json, 'erros', 'erro') || [], campo(json, 'alertas') || []);
  return lista.filter(Boolean).map((e) => ({
    codigo: campo(e, 'codigo') || '',
    mensagem: campo(e, 'descricao', 'mensagem') || JSON.stringify(e),
    correcao: campo(e, 'complemento') || '',
  }));
}

export function extrairNfse(xml) {
  const pega = (t) => xml.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];
  return {
    chaveAcesso: xml.match(/<infNFSe[^>]*Id="NFS(\d{50})"/)?.[1],
    numero: pega('nNFSe'),
    dataProcessamento: pega('dhProc'),
    codigoStatus: pega('cStat'),
  };
}

function parseJson(res) {
  const txt = res.body.toString('utf8');
  try { return JSON.parse(txt); } catch { return { erros: [{ descricao: `HTTP ${res.status}: ${txt.slice(0, 500)}` }] }; }
}

// ---------------------------------------------------------------- provedor

export const nacional = {
  id: 'nacional',
  nome: 'NFS-e Padrão Nacional (Sefin/ADN)',

  gerarXml(ctx) {
    const { xml, id } = montarDps(ctx);
    const assinado = ctx.cert ? assinarXml(xml, { cert: ctx.cert, elemento: 'infDPS', algoritmo: 'sha256' }) : null;
    return { xml: assinado || xml, assinado: !!assinado, idDps: id };
  },

  async emitir(ctx) {
    const { xml, idDps: id } = this.gerarXml(ctx);
    const url = `${URLS[ctx.ambiente].sefin}/nfse`;
    const res = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ dpsXmlGZipB64: gz(xml) }),
      ...tls(ctx),
    });
    const json = parseJson(res);
    const base = { xmlEnvio: xml, idDps: id, respostaBruta: json, mensagens: mensagensDe(json) };
    const nfseB64 = campo(json, 'nfseXmlGZipB64');
    if (res.status >= 200 && res.status < 300 && nfseB64) {
      const nfseXml = gunz(nfseB64);
      const info = extrairNfse(nfseXml);
      return {
        ...base, status: 'autorizada', xmlRetorno: nfseXml,
        numero: info.numero, chaveAcesso: campo(json, 'chaveAcesso') || info.chaveAcesso,
        dataAutorizacao: info.dataProcessamento || campo(json, 'dataHoraProcessamento'),
      };
    }
    if (res.status >= 500 || res.status === 0) return { ...base, status: 'processando' };
    return { ...base, status: 'rejeitada' };
  },

  async consultar(ctx, nota) {
    let chave = nota.chaveAcesso;
    if (!chave && nota.idDps) {
      const r = await request(`${URLS[ctx.ambiente].sefin}/dps/${nota.idDps}`, { headers: { Accept: 'application/json' }, ...tls(ctx) });
      if (r.status === 404) return { status: nota.status, mensagens: [{ mensagem: 'DPS ainda não processada pela Sefin Nacional.' }] };
      chave = campo(parseJson(r), 'chaveAcesso');
    }
    if (!chave) return { status: nota.status, mensagens: [{ mensagem: 'Nota sem chave de acesso ou ID de DPS para consulta.' }] };

    const r = await request(`${URLS[ctx.ambiente].sefin}/nfse/${chave}`, { headers: { Accept: 'application/json' }, ...tls(ctx) });
    const json = parseJson(r);
    const b64 = campo(json, 'nfseXmlGZipB64');
    if (r.status !== 200 || !b64) return { status: nota.status, mensagens: mensagensDe(json) };
    const nfseXml = gunz(b64);
    const info = extrairNfse(nfseXml);

    // Evento de cancelamento registrado?
    let cancelada = false;
    const ev = await request(`${URLS[ctx.ambiente].sefin}/nfse/${chave}/eventos/101101/1`, { headers: { Accept: 'application/json' }, ...tls(ctx) })
      .catch(() => null);
    if (ev && ev.status === 200) cancelada = true;

    return {
      status: cancelada ? 'cancelada' : 'autorizada',
      chaveAcesso: chave, numero: info.numero, xmlRetorno: nfseXml, mensagens: [],
    };
  },

  async cancelar(ctx, nota, { codigo, motivo }) {
    if (!nota.chaveAcesso) throw new Error('Nota sem chave de acesso.');
    const xml = assinarXml(
      montarCancelamento({ prestador: ctx.prestador, chave: nota.chaveAcesso, ambiente: ctx.ambiente, codigo, motivo }),
      { cert: ctx.cert, elemento: 'infPedReg', algoritmo: 'sha256' });
    const res = await request(`${URLS[ctx.ambiente].sefin}/nfse/${nota.chaveAcesso}/eventos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ pedidoRegistroEventoXmlGZipB64: gz(xml) }),
      ...tls(ctx),
    });
    const json = parseJson(res);
    const ok = res.status >= 200 && res.status < 300;
    const evB64 = campo(json, 'eventoXmlGZipB64');
    return {
      sucesso: ok, xmlEnvio: xml, xmlRetorno: evB64 ? gunz(evB64) : JSON.stringify(json),
      mensagens: mensagensDe(json),
    };
  },

  /** DANFSe oficial em PDF, gerado pelo ADN. */
  async danfse(ctx, nota) {
    if (!nota.chaveAcesso) throw new Error('Nota sem chave de acesso.');
    const r = await request(`${URLS[ctx.ambiente].adn}/danfse/${nota.chaveAcesso}`, { headers: { Accept: 'application/pdf' }, ...tls(ctx) });
    if (r.status !== 200) throw new Error(`ADN respondeu HTTP ${r.status} ao gerar o DANFSe.`);
    return { contentType: 'application/pdf', body: r.body };
  },

  /** Parâmetros municipais (alíquotas, convênio) publicados no ADN. */
  async parametrosMunicipais(ctx, codigoMunicipio, codigoServico) {
    const caminho = codigoServico
      ? `${codigoMunicipio}/${codigoServico}`
      : `${codigoMunicipio}/convenio`;
    const r = await request(`${URLS[ctx.ambiente].adn}/parametrizacao/${caminho}`, { headers: { Accept: 'application/json' }, ...tls(ctx) });
    return { status: r.status, dados: parseJson(r) };
  },
};

export function tls(ctx) {
  if (!ctx.cert) throw new Error('Certificado digital A1 do prestador não cadastrado.');
  return { key: ctx.cert.keyPem, cert: ctx.cert.certPem };
}
