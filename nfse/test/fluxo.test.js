import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { certificadoTeste } from './_cert.js';

process.env.NFSE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-'));
const svc = await import('../src/core/emissao.js');
const { URLS } = await import('../src/providers/nacional.js');
const { salvarMunicipio } = await import('../src/core/municipios.js');
const { esc } = await import('../src/util/xml.js');

const chamadas = [];
let servidor;
let porta;
const CHAVE = '33045572112223330001810000000000000126100000000123';

before(async () => {
  servidor = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      chamadas.push({ metodo: req.method, url: req.url, body, headers: req.headers });
      const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.method === 'POST' && req.url === '/sefin/nfse') {
        const dps = gunzipSync(Buffer.from(JSON.parse(body).dpsXmlGZipB64, 'base64')).toString();
        if (dps.includes('<vServ>666.00</vServ>'))
          return json(400, { erros: [{ Codigo: 'E0712', Descricao: 'Código de tributação nacional inexistente', Complemento: 'cTribNac' }] });
        const nfse = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${CHAVE}"><nNFSe>1</nNFSe><dhProc>2026-10-08T10:00:00-03:00</dhProc><cStat>100</cStat>${dps}</infNFSe></NFSe>`;
        return json(201, { chaveAcesso: CHAVE, nfseXmlGZipB64: gzipSync(nfse).toString('base64') });
      }
      if (req.method === 'GET' && req.url === `/sefin/nfse/${CHAVE}`) {
        const nfse = `<NFSe><infNFSe Id="NFS${CHAVE}"><nNFSe>1</nNFSe></infNFSe></NFSe>`;
        return json(200, { chaveAcesso: CHAVE, nfseXmlGZipB64: gzipSync(nfse).toString('base64') });
      }
      if (req.method === 'GET' && req.url.startsWith(`/sefin/nfse/${CHAVE}/eventos`)) {
        return chamadas.some((c) => c.url === `/sefin/nfse/${CHAVE}/eventos` && c.metodo === 'POST') ? json(200, {}) : json(404, {});
      }
      if (req.method === 'POST' && req.url === `/sefin/nfse/${CHAVE}/eventos`) {
        return json(201, { eventoXmlGZipB64: gzipSync('<evento>ok</evento>').toString('base64') });
      }
      if (req.url === '/abrasf') {
        const retorno = `<GerarNfseResposta xmlns="http://www.abrasf.org.br/nfse.xsd"><ListaNfse><CompNfse><Nfse><InfNfse><Numero>2026000045</Numero><CodigoVerificacao>AB12-CD34</CodigoVerificacao><DataEmissao>2026-10-08T10:00:00</DataEmissao></InfNfse></Nfse></CompNfse></ListaNfse></GerarNfseResposta>`;
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(`<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GerarNfseResponse xmlns="http://nfse.abrasf.org.br"><outputXML>${esc(retorno)}</outputXML></GerarNfseResponse></soap:Body></soap:Envelope>`);
      }
      json(404, { erro: 'rota não simulada' });
    });
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  porta = servidor.address().port;
  URLS.homologacao.sefin = `http://127.0.0.1:${porta}/sefin`;
});
after(() => servidor.close());

const notaBase = (prestadorId, valor = 1000) => ({
  prestadorId, competencia: '2026-10-01',
  tomador: { tipo: 'PF', documento: '529.982.247-25', nome: 'Fulano de Tal' },
  servico: { codigoTributacaoNacional: '010701', itemListaServico: '01.07', discriminacao: 'Desenvolvimento de sistema' },
  valores: { servico: valor, aliquotaIss: 3 },
});

test('fluxo completo no Padrão Nacional: emitir, rejeitar, consultar e cancelar', async () => {
  const p = svc.salvarPrestador({ razaoSocial: 'Empresa Teste', documento: '11.222.333/0001-81', codigoMunicipio: '3304557', municipio: 'Rio de Janeiro', uf: 'RJ', inscricaoMunicipal: '123' });
  await assert.rejects(svc.emitir(notaBase(p.id)), /certificado/i);

  const instalado = svc.instalarCertificado(p.id, certificadoTeste(), '1234');
  assert.equal(instalado.certificado.documento, '11222333000181');
  assert.equal(instalado.certificado.pfx, undefined, 'PFX não vaza pela API');

  const prev = svc.previsualizar(notaBase(p.id));
  assert.ok(prev.assinado);
  assert.equal(prev.idDps.length, 45);

  // Rejeição não consome a numeração
  const rej = await svc.emitir(notaBase(p.id, 666));
  assert.equal(rej.status, 'rejeitada');
  assert.equal(rej.mensagens[0].codigo, 'E0712');
  assert.equal(svc.obterPrestador(p.id).proximoNumero, 1);

  const nf = await svc.emitir(notaBase(p.id));
  assert.equal(nf.status, 'autorizada');
  assert.equal(nf.chaveAcesso, CHAVE);
  assert.equal(nf.numero, '1');
  assert.equal(nf.calculo.valorIss, 30);
  assert.equal(svc.obterPrestador(p.id).proximoNumero, 2);
  assert.match(svc.obterNota(nf.id).xmlRetorno, /<NFSe/);

  const cons = await svc.consultar(nf.id);
  assert.equal(cons.status, 'autorizada');

  await assert.rejects(svc.cancelar(nf.id, { codigo: 1, motivo: 'curto' }), /15 caracteres/);
  const canc = await svc.cancelar(nf.id, { codigo: 1, motivo: 'Erro no valor do servico informado' });
  assert.ok(canc.sucesso);
  assert.equal(svc.obterNota(nf.id).status, 'cancelada');
  const evento = chamadas.find((c) => c.url.endsWith('/eventos') && c.metodo === 'POST');
  const pedido = gunzipSync(Buffer.from(JSON.parse(evento.body).pedidoRegistroEventoXmlGZipB64, 'base64')).toString();
  assert.match(pedido, /<pedRegEvento[\s\S]*<Signature/);
  assert.equal((await svc.consultar(nf.id)).status, 'cancelada');
});

test('emissões simultâneas não repetem o número da DPS', async () => {
  const p = svc.salvarPrestador({ razaoSocial: 'Outra', documento: '11222333000181', codigoMunicipio: '3304557', serie: '2', proximoNumero: 10 });
  svc.instalarCertificado(p.id, certificadoTeste(), '1234');
  const antes = chamadas.length;
  await Promise.all([1, 2, 3].map(() => svc.emitir(notaBase(p.id))));
  const numeros = chamadas.slice(antes).filter((c) => c.url === '/sefin/nfse')
    .map((c) => gunzipSync(Buffer.from(JSON.parse(c.body).dpsXmlGZipB64, 'base64')).toString().match(/<nDPS>(\d+)/)[1]);
  assert.deepEqual(numeros.sort(), ['10', '11', '12']);
  assert.equal(svc.obterPrestador(p.id).proximoNumero, 13);
});

test('município com sistema próprio (ABRASF) via SOAP', async () => {
  salvarMunicipio('9999999', { nome: 'Cidade Teste', uf: 'XX', provedor: 'abrasf', preset: 'abrasf-2.04',
    urls: { homologacao: `http://127.0.0.1:${porta}/abrasf` } });
  const p = svc.salvarPrestador({ razaoSocial: 'Empresa ABRASF', documento: '11222333000181', codigoMunicipio: '9999999', inscricaoMunicipal: '555' });
  svc.instalarCertificado(p.id, certificadoTeste(), '1234');
  const nf = await svc.emitir({ ...notaBase(p.id), servico: { ...notaBase(p.id).servico } });
  assert.equal(nf.provedor, 'abrasf');
  assert.equal(nf.status, 'autorizada');
  assert.equal(nf.numero, '2026000045');
  assert.equal(nf.codigoVerificacao, 'AB12-CD34');
  const soapCall = chamadas.find((c) => c.url === '/abrasf');
  assert.equal(soapCall.headers.soapaction, '"http://nfse.abrasf.org.br/GerarNfse"');
  assert.match(soapCall.body, /<nfseDadosMsg>&lt;GerarNfseEnvio/);
});
