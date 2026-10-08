import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerCertificado } from '../src/core/certificado.js';
import { verificarAssinatura } from '../src/core/assinatura.js';
import { nacional, montarDps, montarCancelamento, idDps } from '../src/providers/nacional.js';
import { abrasf } from '../src/providers/abrasf.js';
import { saoPaulo, stringAssinaturaRps } from '../src/providers/sao-paulo.js';
import { parseXml } from '../src/providers/_resposta.js';
import { certificadoTeste } from './_cert.js';

const cert = lerCertificado(certificadoTeste(), '1234');

const prestador = {
  documento: '11222333000181', inscricaoMunicipal: '12345678', codigoMunicipio: '3304557',
  opSimpNac: 3, regApTribSN: 1, regEspTrib: 0, email: 'fiscal@empresa.com.br',
};
const nota = {
  competencia: '2026-10-01',
  tomador: {
    tipo: 'PJ', documento: '12.ABC.345/01DE-35', nome: 'Cliente & Filhos S/A', email: 'nf@cliente.com',
    endereco: { logradouro: 'Rua A', numero: '10', bairro: 'Centro', cep: '20000-000', codigoMunicipio: '3304557', uf: 'RJ' },
  },
  servico: { itemListaServico: '01.07', codigoTributacaoNacional: '010701', discriminacao: 'Suporte técnico <mensal>', codigoServicoMunicipal: '02919' },
  valores: { servico: 1500, aliquotaIss: 2.5, issRetido: false, ir: 22.5 },
};

test('ID da DPS tem 45 posições no formato oficial', () => {
  const id = idDps({ codigoMunicipio: '3304557', documento: '11222333000181', serie: '1', numero: 42 });
  assert.equal(id, 'DPS3304557211222333000181' + '00001' + '000000000000042');
  assert.equal(id.length, 45);
  assert.equal(idDps({ codigoMunicipio: '3304557', documento: '52998224725', serie: '1', numero: 1 }).slice(10, 11), '1');
});

test('DPS Nacional v1.01: estrutura, ordem dos grupos e assinatura', () => {
  const { xml, id } = montarDps({ prestador, nota, ambiente: 'homologacao', serie: '1', numero: 7 });
  const doc = parseXml(xml);
  const inf = doc.DPS.infDPS;
  assert.equal(doc.DPS['@versao'], '1.01');
  assert.equal(inf['@Id'], id);
  assert.equal(inf.tpAmb, '2');
  assert.equal(inf.serie, '00001');
  assert.equal(inf.nDPS, '7');
  assert.equal(inf.prest.regTrib.opSimpNac, '3');
  assert.equal(inf.toma.CNPJ, '12ABC34501DE35');
  assert.equal(inf.serv.cServ.cTribNac, '010701');
  assert.equal(inf.valores.vServPrest.vServ, '1500.00');
  assert.equal(inf.valores.trib.tribMun.pAliq, '2.50'); // optante ME/EPP informa alíquota
  assert.equal(inf.valores.trib.tribFed.vRetIRRF, '22.50');
  const ordem = [...xml.matchAll(/<(\w+)[ >]/g)].map((m) => m[1]);
  const pos = (t) => ordem.indexOf(t);
  for (const [a, b] of [['tpAmb', 'dhEmi'], ['cLocEmi', 'prest'], ['prest', 'toma'], ['toma', 'serv'], ['serv', 'valores'], ['tribMun', 'tribFed'], ['tribFed', 'totTrib']])
    assert.ok(pos(a) < pos(b), `${a} antes de ${b}`);
  assert.match(xml, /Cliente &amp; Filhos/);

  const { xml: assinado } = nacional.gerarXml({ prestador, nota, ambiente: 'homologacao', serie: '1', numero: 7, cert });
  assert.match(assinado, /<\/infDPS><Signature xmlns="http:\/\/www.w3.org\/2000\/09\/xmldsig#">/);
  assert.match(assinado, /rsa-sha256/);
  assert.match(assinado, new RegExp(`URI="#${id}"`));
  assert.ok(verificarAssinatura(assinado, cert.certPem));
  assert.ok(!verificarAssinatura(assinado.replace('1500.00', '1.00'), cert.certPem), 'adulteração detectada');
});

test('tomador não identificado omite o grupo toma; prestador não optante não informa pAliq', () => {
  const { xml } = montarDps({ prestador: { ...prestador, opSimpNac: 1 }, nota: { ...nota, tomador: { tipo: 'NI' } }, ambiente: 'producao', serie: '1', numero: 1 });
  assert.ok(!xml.includes('<toma>'));
  assert.ok(!xml.includes('<pAliq>'));
  assert.ok(!xml.includes('<regApTribSN>'));
  assert.match(xml, /<tpAmb>1<\/tpAmb>/);
});

test('evento de cancelamento Nacional', () => {
  const chave = '3304557211222333000181000000000000726100000000123';
  assert.throws(() => montarCancelamento({ prestador, chave: chave + '4', ambiente: 'homologacao', codigo: 1, motivo: 'curto' }), /15 caracteres/);
  const xml = montarCancelamento({ prestador, chave: chave + '4', ambiente: 'homologacao', codigo: 2, motivo: 'Servico nao foi prestado ao cliente' });
  const id = xml.match(/Id="([^"]+)"/)[1];
  assert.equal(id.length, 59);
  assert.equal(id, `PRE${chave}4101101`);
  assert.match(xml, /<e101101><xDesc>Cancelamento de NFS-e<\/xDesc><cMotivo>2<\/cMotivo>/);
});

test('ABRASF 2.04: GerarNfseEnvio assinado', () => {
  const ctx = { prestador, nota, serie: 'A1', numero: 15, cert, municipio: { preset: 'abrasf-2.04' } };
  const { xml } = abrasf.gerarXml(ctx);
  const doc = parseXml(xml);
  const inf = doc.GerarNfseEnvio.Rps.InfDeclaracaoPrestacaoServico;
  assert.equal(inf.Rps.IdentificacaoRps.Numero, '15');
  assert.equal(inf.Servico.Valores.ValorServicos, '1500.00');
  assert.equal(inf.Servico.Valores.ValorIss, '37.50');
  assert.equal(inf.Servico.IssRetido, '2');
  assert.equal(inf.Servico.ItemListaServico, '01.07');
  assert.equal(inf.TomadorServico.IdentificacaoTomador.CpfCnpj.Cnpj, '12ABC34501DE35');
  assert.equal(inf.OptanteSimplesNacional, '1');
  assert.match(xml, /<\/InfDeclaracaoPrestacaoServico><Signature/);
  assert.match(xml, /rsa-sha1/);
  assert.ok(verificarAssinatura(xml, cert.certPem));

  const b = abrasf.gerarXml({ ...ctx, municipio: { preset: 'betha-2.02' } }).xml;
  assert.match(b, /<GerarNfseEnvio xmlns="http:\/\/www.betha.com.br\/e-nota-contribuinte-ws">/);
  assert.match(b, /<Tomador>/);
});

test('São Paulo: string de assinatura do RPS (86 posições) e mensagem assinada', () => {
  const s = stringAssinaturaRps({
    inscricao: '39616924', serie: 'OL03', numero: 1, dataEmissao: '2026-01-15', tributacao: 'T', status: 'N',
    issRetido: false, valorServicos: 20500, valorDeducoes: 5000, codigoServico: '02658', docTomador: '13167474254',
  });
  assert.equal(s.length, 86);
  assert.equal(s.slice(0, 8), '39616924');
  assert.equal(s.slice(8, 13), 'OL03 ');
  assert.equal(s.slice(13, 25), '000000000001');
  assert.equal(s.slice(25, 33), '20260115');
  assert.equal(s.slice(33, 36), 'TNN');
  assert.equal(s.slice(36, 51), '000000002050000');
  assert.equal(s.slice(51, 66), '000000000500000');
  assert.equal(s.slice(66, 71), '02658');
  assert.equal(s.slice(71, 72), '1');
  assert.equal(s.slice(72), '00013167474254');

  const { xml } = saoPaulo.gerarXml({ prestador, nota, serie: '1', numero: 3, cert, ambiente: 'producao' });
  assert.match(xml, /^<PedidoEnvioRPS xmlns="http:\/\/www.prefeitura.sp.gov.br\/nfe">/);
  assert.match(xml, /<AliquotaServicos>0.0250<\/AliquotaServicos>/);
  assert.match(xml, /<Reference URI="">/);
  assert.ok(verificarAssinatura(xml, cert.certPem));
  const teste = saoPaulo.gerarXml({ prestador, nota, serie: '1', numero: 3, cert, ambiente: 'homologacao' }).xml;
  assert.match(teste, /^<PedidoEnvioLoteRPS/);
  assert.match(teste, /<QtdRPS>1<\/QtdRPS>/);
});
