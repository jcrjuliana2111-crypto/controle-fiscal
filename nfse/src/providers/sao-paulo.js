// NFS-e Paulistana (Prefeitura de São Paulo) — sistema próprio, leiaute v1.
// Além da assinatura XMLDSig da mensagem, cada RPS leva uma "Assinatura"
// própria: hash SHA-1 assinado (RSA) de uma string de 86 posições.

import crypto from 'node:crypto';
import { tag, grupo, normDoc, onlyDigits, money, limparTexto, esc, hojeBrasilia } from '../util/xml.js';
import { assinarXml } from '../core/assinatura.js';
import { calcular } from '../core/calculo.js';
import { soap } from '../util/http.js';
import { parseXml, corpoSoap, todos, primeiro, texto } from './_resposta.js';
import { tls } from './nacional.js';
import { exigirEnderecoPublico } from '../util/rede.js';

const URL_WS = 'https://nfe.prefeitura.sp.gov.br/ws/lotenfe.asmx';
const NS = 'http://www.prefeitura.sp.gov.br/nfe';
const ACTION = 'http://www.prefeitura.sp.gov.br/nfe/ws/';

const assinarSha1 = (s, keyPem) => crypto.createSign('RSA-SHA1').update(s, 'ascii').sign(keyPem, 'base64');

/** String de 86 posições usada na tag <Assinatura> do RPS (manual v1, item 4.3.2). */
export function stringAssinaturaRps({ inscricao, serie, numero, dataEmissao, tributacao, status, issRetido, valorServicos, valorDeducoes, codigoServico, docTomador }) {
  const doc = normDoc(docTomador);
  const indicador = !doc ? '3' : doc.length === 11 ? '1' : '2';
  const cent = (v) => String(Math.round(Number(v || 0) * 100)).padStart(15, '0');
  return onlyDigits(inscricao).padStart(8, '0') +
    String(serie).padEnd(5, ' ').slice(0, 5) +
    onlyDigits(numero).padStart(12, '0') +
    dataEmissao.replace(/-/g, '') +
    tributacao + status + (issRetido ? 'S' : 'N') +
    cent(valorServicos) + cent(valorDeducoes) +
    onlyDigits(codigoServico).padStart(5, '0') +
    indicador + (doc || '').padStart(14, '0');
}

function cpfCnpj(nomeGrupo, doc) {
  const d = normDoc(doc);
  return grupo(nomeGrupo, d.length === 11 ? tag('CPF', d) : tag('CNPJ', d));
}

export function montarRpsSp({ prestador: p, nota, serie, numero, cert }) {
  const v = nota.valores || {};
  const s = nota.servico || {};
  const t = nota.tomador || {};
  const calc = calcular(v);
  const data = hojeBrasilia();
  const tributacao = s.tributacaoSp || 'T';
  const codigoServico = onlyDigits(s.codigoServicoMunicipal || s.codigoTributacaoMunicipal);
  const docTomador = t.tipo === 'PJ' || t.tipo === 'PF' ? normDoc(t.documento) : '';

  const str = stringAssinaturaRps({
    inscricao: p.inscricaoMunicipal, serie, numero, dataEmissao: data, tributacao, status: 'N',
    issRetido: !!v.issRetido, valorServicos: calc.valorServico, valorDeducoes: calc.deducoes,
    codigoServico, docTomador,
  });
  const assinatura = cert ? assinarSha1(str, cert.keyPem) : '';
  const e = t.endereco || {};

  const rps = `<RPS xmlns="">` +
    tag('Assinatura', assinatura || 'PENDENTE') +
    grupo('ChaveRPS', tag('InscricaoPrestador', onlyDigits(p.inscricaoMunicipal).padStart(8, '0')) + tag('SerieRPS', serie) + tag('NumeroRPS', Number(numero))) +
    tag('TipoRPS', 'RPS') + tag('DataEmissao', data) + tag('StatusRPS', 'N') + tag('TributacaoRPS', tributacao) +
    tag('ValorServicos', money(calc.valorServico)) + tag('ValorDeducoes', money(calc.deducoes)) +
    tag('ValorPIS', money(v.pis)) + tag('ValorCOFINS', money(v.cofins)) + tag('ValorINSS', money(v.inss)) +
    tag('ValorIR', money(v.ir)) + tag('ValorCSLL', money(v.csll)) +
    tag('CodigoServico', codigoServico) +
    tag('AliquotaServicos', (Number(v.aliquotaIss || 0) / 100).toFixed(4)) +
    tag('ISSRetido', v.issRetido ? 'true' : 'false') +
    (docTomador ? cpfCnpj('CPFCNPJTomador', docTomador) : '') +
    tag('InscricaoMunicipalTomador', onlyDigits(t.inscricaoMunicipal)) +
    tag('RazaoSocialTomador', limparTexto(t.nome, 75)) +
    (e.logradouro ? grupo('EnderecoTomador',
      tag('Logradouro', limparTexto(e.logradouro, 50)) + tag('NumeroEndereco', limparTexto(e.numero, 10)) +
      tag('ComplementoEndereco', limparTexto(e.complemento, 30)) + tag('Bairro', limparTexto(e.bairro, 30)) +
      tag('Cidade', onlyDigits(e.codigoMunicipio)) + tag('UF', e.uf) + tag('CEP', onlyDigits(e.cep))) : '') +
    tag('EmailTomador', t.email) +
    tag('Discriminacao', limparTexto(s.discriminacao, 2000)) +
    `</RPS>`;
  return { rps, stringAssinatura: str, calc, data };
}

async function chamar(ctx, operacao, mensagem) {
  const body = `<${operacao}Request xmlns="${NS}"><VersaoSchema>1</VersaoSchema><MensagemXML>${esc(mensagem)}</MensagemXML></${operacao}Request>`;
  const url = ctx.municipio?.urls?.[ctx.ambiente] || URL_WS;
  await exigirEnderecoPublico(url);
  const res = await soap(url, {
    action: ACTION + operacao.charAt(0).toLowerCase() + operacao.slice(1), body, ...tls(ctx),
  });
  const xml = corpoSoap(res.text);
  return { xml, doc: parseXml(xml) };
}

function mensagens(doc) {
  return [...todos(doc, 'Erro'), ...todos(doc, 'Alerta')].map((m) => ({
    codigo: texto(m.Codigo), mensagem: texto(m.Descricao), correcao: '',
  }));
}

const remetente = (p) => `<Cabecalho xmlns="" Versao="1">${cpfCnpj('CPFCNPJRemetente', p.documento)}`;

export const saoPaulo = {
  id: 'sao-paulo',
  nome: 'NFS-e Paulistana (São Paulo/SP)',

  gerarXml(ctx) {
    const { rps, calc, data } = montarRpsSp(ctx);
    const p = ctx.prestador;
    let xml;
    if (ctx.ambiente === 'producao') {
      xml = `<PedidoEnvioRPS xmlns="${NS}">${remetente(p)}</Cabecalho>${rps}</PedidoEnvioRPS>`;
    } else {
      // São Paulo não tem ambiente de homologação: usa o "TesteEnvioLoteRPS",
      // que valida a mensagem completa sem gerar NFS-e.
      xml = `<PedidoEnvioLoteRPS xmlns="${NS}">${remetente(p)}` +
        tag('transacao', 'true') + tag('dtInicio', data) + tag('dtFim', data) + tag('QtdRPS', 1) +
        tag('ValorTotalServicos', money(calc.valorServico)) + tag('ValorTotalDeducoes', money(calc.deducoes)) +
        `</Cabecalho>${rps}</PedidoEnvioLoteRPS>`;
    }
    if (ctx.cert) xml = assinarXml(xml, { cert: ctx.cert, algoritmo: 'sha1' });
    return { xml, assinado: !!ctx.cert };
  },

  async emitir(ctx) {
    const { xml } = this.gerarXml(ctx);
    const operacao = ctx.ambiente === 'producao' ? 'EnvioRPS' : 'TesteEnvioLoteRPS';
    const { xml: ret, doc } = await chamar(ctx, operacao, xml);
    const sucesso = String(primeiro(doc, 'Cabecalho')?.['@Sucesso']) === 'true';
    const chave = primeiro(doc, 'ChaveNFe');
    const msgs = mensagens(doc);
    if (sucesso && chave) {
      return {
        status: 'autorizada', numero: texto(chave.NumeroNFe), codigoVerificacao: texto(chave.CodigoVerificacao),
        linkConsulta: `https://nfe.prefeitura.sp.gov.br/contribuinte/notaprint.aspx?inscricao=${onlyDigits(ctx.prestador.inscricaoMunicipal)}&nf=${texto(chave.NumeroNFe)}&verificacao=${texto(chave.CodigoVerificacao)}`,
        xmlEnvio: xml, xmlRetorno: ret, mensagens: msgs,
      };
    }
    if (sucesso && ctx.ambiente !== 'producao') {
      return { status: 'validada', xmlEnvio: xml, xmlRetorno: ret,
        mensagens: [{ codigo: 'TESTE', mensagem: 'Mensagem validada pela Prefeitura de SP (teste — nenhuma NFS-e foi gerada).' }, ...msgs] };
    }
    return { status: 'rejeitada', xmlEnvio: xml, xmlRetorno: ret, mensagens: msgs };
  },

  async consultar(ctx, nota) {
    const p = ctx.prestador;
    const im = onlyDigits(p.inscricaoMunicipal).padStart(8, '0');
    const detalhe = nota.numero
      ? grupo('ChaveNFe', tag('InscricaoPrestador', im) + tag('NumeroNFe', nota.numero))
      : grupo('ChaveRPS', tag('InscricaoPrestador', im) + tag('SerieRPS', nota.serie) + tag('NumeroRPS', Number(nota.numeroRps)));
    let xml = `<PedidoConsultaNFe xmlns="${NS}">${remetente(p)}</Cabecalho><Detalhe xmlns="">${detalhe}</Detalhe></PedidoConsultaNFe>`;
    xml = assinarXml(xml, { cert: ctx.cert, algoritmo: 'sha1' });
    const { xml: ret, doc } = await chamar(ctx, 'ConsultaNFe', xml);
    const nfe = primeiro(doc, 'NFe');
    if (!nfe) return { status: nota.status, mensagens: mensagens(doc), xmlRetorno: ret };
    return {
      status: texto(nfe.StatusNFe) === 'C' ? 'cancelada' : 'autorizada',
      numero: texto(nfe.ChaveNFe?.NumeroNFe), codigoVerificacao: texto(nfe.ChaveNFe?.CodigoVerificacao),
      xmlRetorno: ret, mensagens: [],
    };
  },

  async cancelar(ctx, nota) {
    const p = ctx.prestador;
    const im = onlyDigits(p.inscricaoMunicipal).padStart(8, '0');
    const assinatura = assinarSha1(im + onlyDigits(nota.numero).padStart(12, '0'), ctx.cert.keyPem);
    let xml = `<PedidoCancelamentoNFe xmlns="${NS}">${remetente(p)}${tag('transacao', 'true')}</Cabecalho>` +
      `<Detalhe xmlns="">${grupo('ChaveNFe', tag('InscricaoPrestador', im) + tag('NumeroNFe', nota.numero))}` +
      `${tag('AssinaturaCancelamento', assinatura)}</Detalhe></PedidoCancelamentoNFe>`;
    xml = assinarXml(xml, { cert: ctx.cert, algoritmo: 'sha1' });
    const { xml: ret, doc } = await chamar(ctx, 'CancelamentoNFe', xml);
    const sucesso = String(primeiro(doc, 'Cabecalho')?.['@Sucesso']) === 'true';
    return { sucesso, xmlEnvio: xml, xmlRetorno: ret, mensagens: mensagens(doc) };
  },
};
