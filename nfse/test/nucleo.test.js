import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cnpjValido, cpfValido, validarNota } from '../src/core/validacao.js';
import { calcular } from '../src/core/calculo.js';
import { lerCertificado } from '../src/core/certificado.js';
import { dataHoraBrasilia } from '../src/util/xml.js';
import { certificadoTeste } from './_cert.js';

test('CNPJ numérico e alfanumérico', () => {
  assert.ok(cnpjValido('11.222.333/0001-81'));
  assert.ok(!cnpjValido('11.222.333/0001-82'));
  assert.ok(cnpjValido('12.ABC.345/01DE-35')); // exemplo oficial da Receita Federal
  assert.ok(!cnpjValido('12.ABC.345/01DE-36'));
  assert.ok(!cnpjValido('00000000000000'));
});

test('CPF', () => {
  assert.ok(cpfValido('529.982.247-25'));
  assert.ok(!cpfValido('529.982.247-24'));
  assert.ok(!cpfValido('111.111.111-11'));
});

test('cálculo de ISS, retenções e líquido sem erro de arredondamento', () => {
  const c = calcular({ servico: 1000, aliquotaIss: 5, issRetido: true, ir: 15, csll: 10, descontoIncondicionado: 100 });
  assert.equal(c.baseCalculo, 900);
  assert.equal(c.valorIss, 45);
  assert.equal(c.valorIssRetido, 45);
  assert.equal(c.retencoesFederais, 25);
  assert.equal(c.valorLiquido, 1000 - 100 - 25 - 45);
  assert.equal(calcular({ servico: 0.1 + 0.2, aliquotaIss: 2 }).valorServico, 0.3);
});

test('validação de nota', () => {
  const prest = { documento: '11222333000181', codigoMunicipio: '3304557' };
  const erros = validarNota({ tomador: { tipo: 'PJ', documento: '123' }, servico: {}, valores: { servico: 0 } }, prest);
  const campos = erros.map((e) => e.campo);
  assert.ok(campos.includes('tomador.documento'));
  assert.ok(campos.includes('servico.discriminacao'));
  assert.ok(campos.includes('valores.servico'));
  assert.deepEqual(validarNota({ tomador: { tipo: 'NI' }, servico: { discriminacao: 'Consultoria' }, valores: { servico: 10 } }, prest), []);
});

test('leitura do certificado A1', () => {
  const info = lerCertificado(certificadoTeste(), '1234');
  assert.equal(info.documento, '11222333000181');
  assert.equal(info.titular, 'EMPRESA TESTE LTDA');
  assert.match(info.keyPem, /PRIVATE KEY/);
  assert.throws(() => lerCertificado(certificadoTeste(), 'errada'), /senha incorreta/);
});

test('data/hora no fuso de Brasília', () => {
  assert.equal(dataHoraBrasilia(new Date('2026-01-01T02:30:00Z')), '2025-12-31T23:30:00-03:00');
});
