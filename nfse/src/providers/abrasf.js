// Padrão ABRASF (versões 2.x) — usado por boa parte das prefeituras com
// sistema próprio (Betha, ISSNet, WebISS, e-Governe, Fiorilli, SigISS etc.).
// Como cada provedor tem pequenas variações (namespace do serviço, nome do
// grupo do tomador, SOAP 1.1/1.2), tudo é configurável por município.

import { tag, grupo, normDoc, onlyDigits, money, dec, limparTexto, esc, hojeBrasilia } from '../util/xml.js';
import { assinarXml } from '../core/assinatura.js';
import { calcular } from '../core/calculo.js';
import { soap } from '../util/http.js';
import { parseXml, corpoSoap, todos, primeiro, texto } from './_resposta.js';
import { tls } from './nacional.js';
import { exigirEnderecoPublico } from '../util/rede.js';

export const PRESETS = {
  'abrasf-2.04': {
    nome: 'ABRASF 2.04 (padrão)',
    versao: '2.04',
    nsDados: 'http://www.abrasf.org.br/nfse.xsd',
    nsServico: 'http://nfse.abrasf.org.br',
    soapAction: 'http://nfse.abrasf.org.br/{operacao}',
    sufixoRequest: 'Request',
    soapVersion: '1.1',
    tagTomador: 'TomadorServico',
    algoritmo: 'sha1',
  },
  'abrasf-2.02': {
    nome: 'ABRASF 2.02',
    versao: '2.02',
    nsDados: 'http://www.abrasf.org.br/nfse.xsd',
    nsServico: 'http://nfse.abrasf.org.br',
    soapAction: 'http://nfse.abrasf.org.br/{operacao}',
    sufixoRequest: 'Request',
    soapVersion: '1.1',
    tagTomador: 'Tomador',
    algoritmo: 'sha1',
  },
  'betha-2.02': {
    nome: 'Betha (ABRASF 2.02)',
    versao: '2.02',
    nsDados: 'http://www.betha.com.br/e-nota-contribuinte-ws',
    nsServico: 'http://www.betha.com.br/e-nota-contribuinte-ws',
    soapAction: '',
    sufixoRequest: '',
    soapVersion: '1.1',
    tagTomador: 'Tomador',
    algoritmo: 'sha1',
  },
};

function cfgDe(municipio = {}) {
  const preset = PRESETS[municipio.preset] || PRESETS['abrasf-2.04'];
  return { ...preset, ...(municipio.opcoes || {}) };
}

function cpfCnpj(doc) {
  const d = normDoc(doc);
  return grupo('CpfCnpj', d.length === 11 ? tag('Cpf', d) : tag('Cnpj', d));
}

/** XML do RPS (InfDeclaracaoPrestacaoServico). */
export function montarRps({ prestador: p, nota, serie, numero, municipio }) {
  const cfg = cfgDe(municipio);
  const v = nota.valores || {};
  const s = nota.servico || {};
  const t = nota.tomador || {};
  const calc = calcular(v);
  const id = `rps${onlyDigits(serie)}${onlyDigits(numero)}`;
  const hoje = hojeBrasilia();

  const valores = grupo('Valores',
    tag('ValorServicos', money(calc.valorServico)) +
    (calc.deducoes ? tag('ValorDeducoes', money(calc.deducoes)) : '') +
    (Number(v.pis) ? tag('ValorPis', money(v.pis)) : '') +
    (Number(v.cofins) ? tag('ValorCofins', money(v.cofins)) : '') +
    (Number(v.inss) ? tag('ValorInss', money(v.inss)) : '') +
    (Number(v.ir) ? tag('ValorIr', money(v.ir)) : '') +
    (Number(v.csll) ? tag('ValorCsll', money(v.csll)) : '') +
    (Number(v.outrasRetencoes) ? tag('OutrasRetencoes', money(v.outrasRetencoes)) : '') +
    // Optante do Simples: ISS e alíquota são informados; demais casos o provedor calcula.
    (calc.valorIss ? tag('ValorIss', money(calc.valorIss)) : '') +
    (Number(v.aliquotaIss) ? tag('Aliquota', dec(v.aliquotaIss, 2)) : '') +
    (calc.descontoIncondicionado ? tag('DescontoIncondicionado', money(calc.descontoIncondicionado)) : '') +
    (calc.descontoCondicionado ? tag('DescontoCondicionado', money(calc.descontoCondicionado)) : ''));

  const servico = grupo('Servico',
    valores +
    tag('IssRetido', v.issRetido ? 1 : 2) +
    (v.issRetido ? tag('ResponsavelRetencao', v.responsavelRetencao === 'intermediario' ? 2 : 1) : '') +
    tag('ItemListaServico', s.itemListaServico) +
    tag('CodigoCnae', onlyDigits(s.cnae)) +
    tag('CodigoTributacaoMunicipio', s.codigoTributacaoMunicipal) +
    (cfg.versao >= '2.04' ? tag('CodigoNbs', onlyDigits(s.codigoNbs)) : '') +
    tag('Discriminacao', limparTexto(s.discriminacao, 2000)) +
    tag('CodigoMunicipio', onlyDigits(s.municipioPrestacao || p.codigoMunicipio)) +
    tag('ExigibilidadeISS', v.exigibilidadeIss || 1) +
    tag('MunicipioIncidencia', onlyDigits(v.municipioIncidencia || s.municipioPrestacao || p.codigoMunicipio)));

  const prestador = grupo('Prestador', cpfCnpj(p.documento) + tag('InscricaoMunicipal', onlyDigits(p.inscricaoMunicipal)));

  let tomador = '';
  if (t.tipo && t.tipo !== 'NI') {
    const e = t.endereco || {};
    const ident = t.tipo === 'EXT'
      ? tag('NifTomador', t.nif)
      : cpfCnpj(t.documento) + tag('InscricaoMunicipal', onlyDigits(t.inscricaoMunicipal));
    tomador = grupo(cfg.tagTomador,
      grupo('IdentificacaoTomador', ident) +
      tag('RazaoSocial', limparTexto(t.nome, 150)) +
      grupo('Endereco',
        tag('Endereco', limparTexto(e.logradouro, 125)) + tag('Numero', limparTexto(e.numero, 10)) +
        tag('Complemento', limparTexto(e.complemento, 60)) + tag('Bairro', limparTexto(e.bairro, 60)) +
        tag('CodigoMunicipio', onlyDigits(e.codigoMunicipio)) + tag('Uf', e.uf) + tag('Cep', onlyDigits(e.cep))) +
      grupo('Contato', tag('Telefone', onlyDigits(t.fone)) + tag('Email', t.email)));
  }

  const op = Number(p.opSimpNac || 1);
  const inf =
    grupo('Rps',
      grupo('IdentificacaoRps', tag('Numero', Number(numero)) + tag('Serie', serie) + tag('Tipo', 1)) +
      tag('DataEmissao', hoje) + tag('Status', 1)) +
    tag('Competencia', nota.competencia || hoje) +
    servico + prestador + tomador +
    (Number(p.regEspTrib) ? tag('RegimeEspecialTributacao', p.regEspTrib) : '') +
    tag('OptanteSimplesNacional', op > 1 ? 1 : 2) +
    tag('IncentivoFiscal', p.incentivoFiscal ? 1 : 2);

  return {
    id,
    xmlRps: `<Rps><InfDeclaracaoPrestacaoServico Id="${id}">${inf}</InfDeclaracaoPrestacaoServico></Rps>`,
    cfg,
  };
}

function cabecalho(cfg) {
  return `<cabecalho xmlns="${cfg.nsDados}" versao="${cfg.versao}"><versaoDados>${cfg.versao}</versaoDados></cabecalho>`;
}

async function chamar(ctx, operacao, dadosXml) {
  const cfg = cfgDe(ctx.municipio);
  const url = ctx.municipio?.urls?.[ctx.ambiente];
  if (!url) throw new Error(`URL do webservice (${ctx.ambiente}) não configurada para o município ${ctx.municipio?.nome || ''}.`);
  await exigirEnderecoPublico(url);
  const wrapper = operacao + (cfg.sufixoRequest || '');
  const body = `<${wrapper} xmlns="${cfg.nsServico}">` +
    `<nfseCabecMsg>${esc(cabecalho(cfg))}</nfseCabecMsg>` +
    `<nfseDadosMsg>${esc(dadosXml)}</nfseDadosMsg></${wrapper}>`;
  const res = await soap(url, {
    action: (cfg.soapAction || '').replace('{operacao}', operacao),
    body, version: cfg.soapVersion, ...tls(ctx),
  });
  if (res.status >= 500 && !res.text.includes('Fault')) throw new Error(`Webservice respondeu HTTP ${res.status}`);
  const xml = corpoSoap(res.text);
  return { xml, doc: parseXml(xml) };
}

function mensagens(doc) {
  return todos(doc, 'MensagemRetorno').map((m) => ({
    codigo: texto(m.Codigo), mensagem: texto(m.Mensagem), correcao: texto(m.Correcao),
  }));
}

function nfseDe(doc) {
  const inf = primeiro(doc, 'InfNfse');
  if (!inf) return null;
  return {
    numero: texto(inf.Numero),
    codigoVerificacao: texto(inf.CodigoVerificacao),
    dataAutorizacao: texto(inf.DataEmissao),
    linkConsulta: texto(inf.OutrasInformacoes).match(/https?:\/\/\S+/)?.[0] || '',
  };
}

export const abrasf = {
  id: 'abrasf',
  nome: 'ABRASF 2.x (webservice da prefeitura)',

  gerarXml(ctx) {
    const { xmlRps, id, cfg } = montarRps(ctx);
    let xml = `<GerarNfseEnvio xmlns="${cfg.nsDados}">${xmlRps}</GerarNfseEnvio>`;
    if (ctx.cert) xml = assinarXml(xml, { cert: ctx.cert, elemento: 'InfDeclaracaoPrestacaoServico', algoritmo: cfg.algoritmo });
    return { xml, assinado: !!ctx.cert, idRps: id };
  },

  async emitir(ctx) {
    const { xml } = this.gerarXml(ctx);
    const { xml: ret, doc } = await chamar(ctx, 'GerarNfse', xml);
    const nf = nfseDe(doc);
    const msgs = mensagens(doc);
    if (nf?.numero) return { status: 'autorizada', ...nf, xmlEnvio: xml, xmlRetorno: ret, mensagens: msgs };
    return { status: msgs.length ? 'rejeitada' : 'processando', xmlEnvio: xml, xmlRetorno: ret, mensagens: msgs };
  },

  async consultar(ctx, nota) {
    const cfg = cfgDe(ctx.municipio);
    const p = ctx.prestador;
    const xml = `<ConsultarNfseRpsEnvio xmlns="${cfg.nsDados}">` +
      grupo('IdentificacaoRps', tag('Numero', Number(nota.numeroRps)) + tag('Serie', nota.serie) + tag('Tipo', 1)) +
      grupo('Prestador', cpfCnpj(p.documento) + tag('InscricaoMunicipal', onlyDigits(p.inscricaoMunicipal))) +
      `</ConsultarNfseRpsEnvio>`;
    const { xml: ret, doc } = await chamar(ctx, 'ConsultarNfsePorRps', xml);
    const nf = nfseDe(doc);
    const cancelada = !!primeiro(doc, 'NfseCancelamento');
    if (nf?.numero) return { status: cancelada ? 'cancelada' : 'autorizada', ...nf, xmlRetorno: ret, mensagens: [] };
    return { status: nota.status, mensagens: mensagens(doc), xmlRetorno: ret };
  },

  async cancelar(ctx, nota, { codigo }) {
    const cfg = cfgDe(ctx.municipio);
    const p = ctx.prestador;
    const id = `C${onlyDigits(nota.numero)}`;
    let xml = `<CancelarNfseEnvio xmlns="${cfg.nsDados}"><Pedido><InfPedidoCancelamento Id="${id}">` +
      grupo('IdentificacaoNfse',
        tag('Numero', nota.numero) + cpfCnpj(p.documento) +
        tag('InscricaoMunicipal', onlyDigits(p.inscricaoMunicipal)) + tag('CodigoMunicipio', p.codigoMunicipio)) +
      tag('CodigoCancelamento', codigo || 1) +
      `</InfPedidoCancelamento></Pedido></CancelarNfseEnvio>`;
    xml = assinarXml(xml, { cert: ctx.cert, elemento: 'InfPedidoCancelamento', algoritmo: cfg.algoritmo });
    const { xml: ret, doc } = await chamar(ctx, 'CancelarNfse', xml);
    const ok = !!primeiro(doc, 'RetCancelamento') || !!primeiro(doc, 'NfseCancelamento');
    return { sucesso: ok, xmlEnvio: xml, xmlRetorno: ret, mensagens: mensagens(doc) };
  },
};
