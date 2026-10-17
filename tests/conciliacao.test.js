// node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../conciliacao-core.js');

test('parseValorBR', () => {
  assert.strictEqual(C.parseValorBR('1.234,56'), 1234.56);
  assert.strictEqual(C.parseValorBR('-150,00'), -150);
  assert.strictEqual(C.parseValorBR('R$ 99,90'), 99.9);
  assert.strictEqual(C.parseValorBR('250.75'), 250.75);
  assert.strictEqual(C.parseValorBR('300,00 D'), -300);
});

test('parseOFX', () => {
  const ofx = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261001120000[-3:BRT]<TRNAMT>1500.00<FITID>A1<MEMO>PIX RECEBIDO ACME COMERCIO
</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261002<TRNAMT>-320.40<FITID>A2<NAME>ENEL<MEMO>PAGTO BOLETO
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const r = C.parseOFX(ofx);
  assert.deepStrictEqual(r, [
    { id: 'A1', data: '2026-10-01', valor: 1500, historico: 'PIX RECEBIDO ACME COMERCIO' },
    { id: 'A2', data: '2026-10-02', valor: -320.4, historico: 'ENEL PAGTO BOLETO' }
  ]);
});

test('parseCSV com ; e colunas crédito/débito', () => {
  const csv = 'Data;Histórico;Crédito;Débito\n01/10/2026;"PIX ACME";1.500,00;\n02/10/2026;ENEL;;320,40\n';
  const r = C.parseCSV(csv);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].valor, 1500);
  assert.strictEqual(r[1].valor, -320.4);
  assert.strictEqual(r[1].data, '2026-10-02');
});

test('conciliar casa por valor, data e nome, sem reutilizar parcelas', () => {
  const movs = [
    { id: 'm1', data: '2026-10-01', valor: 1500, historico: 'PIX RECEBIDO ACME COMERCIO' },
    { id: 'm2', data: '2026-10-02', valor: -320.4, historico: 'ENEL PAGTO BOLETO' },
    { id: 'm3', data: '2026-10-03', valor: 1500, historico: 'TED BETA SERVICOS' },
    { id: 'm4', data: '2026-10-03', valor: 77.77, historico: 'X' }
  ];
  const parcelas = [
    { id: 'p1', tipo: 'receber', vencimento: '2026-10-01', valor: 1500, nome: 'Beta Serviços Ltda' },
    { id: 'p2', tipo: 'receber', vencimento: '2026-09-30', valor: 1500, nome: 'ACME Comércio' },
    { id: 'p3', tipo: 'pagar', vencimento: '2026-10-02', valor: 320.4, nome: 'Enel Distribuição' },
    { id: 'p4', tipo: 'pagar', vencimento: '2026-10-03', valor: 77.77, nome: 'Outro' }
  ];
  const r = C.conciliar(movs, parcelas, { janelaDias: 5 });
  const mapa = Object.fromEntries(r.pares.map(p => [p.movimento.id, p.parcela.id]));
  assert.strictEqual(mapa.m1, 'p2');
  assert.strictEqual(mapa.m3, 'p1');
  assert.strictEqual(mapa.m2, 'p3');
  assert.strictEqual(mapa.m4, undefined); // entrada não casa com conta a pagar
  assert.deepStrictEqual(r.semParcela.map(m => m.id), ['m4']);
  assert.deepStrictEqual(r.parcelasSemMovimento.map(p => p.id), ['p4']);
  assert.ok(r.pares.every(p => p.confianca === 'alta'));
});

test('conciliar respeita a janela de dias', () => {
  const r = C.conciliar(
    [{ id: 'm', data: '2026-10-20', valor: 100, historico: '' }],
    [{ id: 'p', tipo: 'receber', vencimento: '2026-10-01', valor: 100, nome: '' }],
    { janelaDias: 5 });
  assert.strictEqual(r.pares.length, 0);
});

test('dadosComprovante lê valores e datas do texto e do nome do arquivo', () => {
  const t = 'Comprovante de Pix\nValor R$ 1.320,40\nData 02/10/2026 14:31\nTarifa R$ 0,00\nFavorecido ENEL DISTRIBUICAO';
  const d = C.dadosComprovante(t, 'pix.pdf');
  assert.deepStrictEqual(d.valores.sort((a, b) => a - b), [132040]);
  assert.deepStrictEqual(d.datas, ['2026-10-02']);
  const n = C.dadosComprovante('', '2026-10-05_aluguel_2500.00.png');
  assert.deepStrictEqual(n.valores, [250000]);
  assert.deepStrictEqual(n.datas, ['2026-10-05']);
  assert.deepStrictEqual(C.dadosComprovante('', 'ENEL 05-10-2026 320,40.jpg').datas, ['2026-10-05']);
});

test('casarComprovantes liga por valor, data e nome', () => {
  const pares = [
    { movimento: { id: 'm1', data: '2026-10-01', valor: -500, historico: 'PIX ENVIADO' }, parcela: { nome: 'Alfa Ltda' } },
    { movimento: { id: 'm2', data: '2026-10-01', valor: -500, historico: 'PIX ENVIADO' }, parcela: { nome: 'Beta SA' } },
    { movimento: { id: 'm3', data: '2026-10-05', valor: 80, historico: 'TED' }, parcela: { nome: 'Gama' } },
    { movimento: { id: 'm4', data: '2026-10-06', valor: -42.5, historico: 'BOLETO' }, parcela: { nome: 'Delta' } }
  ];
  const comps = [
    { id: 'c1', valores: [50000, 0], datas: ['2026-10-01'], texto: 'BETA SA' },
    { id: 'c2', valores: [50000], datas: ['2026-10-02'], texto: 'ALFA LTDA' },
    { id: 'c3', valores: [8000], datas: ['2026-10-20'], texto: 'Gama' }, // fora da janela
    { id: 'c4', valores: [4250], datas: [], texto: 'boleto delta' }      // sem data: só valor
  ];
  assert.deepStrictEqual(C.casarComprovantes(pares, comps, { janelaDias: 3 }), { m1: 'c2', m2: 'c1', m4: 'c4' });
});

test('formatos do escritório: PIX com descrição e fornecedor com V ddmmaa', () => {
  const pix = C.dadosComprovante('FAVORECIDO: ALANA GONCALVES RODRIGUES\nVALOR R$ 490,00\nTIPO: PIX ENVIADO -\nFOLHA MULTI AGO 26', 'a.pdf');
  assert.deepStrictEqual(pix.valores, [49000]);
  assert.deepStrictEqual(pix.datas, []);
  const forn = C.dadosComprovante('', 'FORNECEDOR F F DISTRIBUIDORA DE PRODUTOS R$ 964,62 V 051026.pdf');
  assert.deepStrictEqual(forn.valores, [96462]);
  assert.deepStrictEqual(forn.vencimentos, ['2026-10-05']);
  assert.deepStrictEqual(forn.datas, []);
  assert.deepStrictEqual(C.dadosComprovante('VENCIMENTO: V051026', '').vencimentos, ['2026-10-05']);

  // duas folhas de R$ 490,00: cada uma vai para a pessoa certa pelo nome/descrição
  const pares = [
    { movimento: { id: 'm1', data: '2026-10-06', valor: -490, historico: 'PIX ENVIADO' },
      parcela: { nome: 'Bruno Lima', descricao: 'FOLHA MULTI AGO 26', vencimento: '2026-10-05' } },
    { movimento: { id: 'm2', data: '2026-10-06', valor: -490, historico: 'PIX ENVIADO' },
      parcela: { nome: 'Alana Goncalves Rodrigues', descricao: 'FOLHA MULTI AGO 26', vencimento: '2026-10-05' } },
    { movimento: { id: 'm3', data: '2026-10-07', valor: -964.62, historico: 'PAG BOLETO' },
      parcela: { nome: 'F F Distribuidora', descricao: 'Compra mercadoria', vencimento: '2026-10-05' } },
    { movimento: { id: 'm4', data: '2026-10-07', valor: -964.62, historico: 'PAG BOLETO' },
      parcela: { nome: 'F F Distribuidora', descricao: 'Compra mercadoria', vencimento: '2026-10-20' } }
  ];
  const r = C.casarComprovantes(pares, [{ id: 'pix', ...pix }, { id: 'forn', ...forn }], { janelaDias: 3 });
  assert.deepStrictEqual(r, { m2: 'pix', m3: 'forn' });
});

test('comprovante sem data e sem nome só é ligado se não houver ambiguidade', () => {
  const par = (id, nome) => ({ movimento: { id, data: '2026-10-06', valor: -490, historico: '' }, parcela: { nome, descricao: 'x' } });
  const c = [{ id: 'c', valores: [49000], datas: [], vencimentos: [], texto: 'VALOR R$ 490,00' }];
  assert.deepStrictEqual(C.casarComprovantes([par('m1', 'Ana')], c), { m1: 'c' });
  assert.deepStrictEqual(C.casarComprovantes([par('m1', 'Ana'), par('m2', 'Bia')], c), {});
});

test('nome do arquivo + texto do PDF juntos', () => {
  // fornecedor pago com atraso: vencimento 05/10 (nome e texto), pago 09/10
  const forn = C.dadosComprovante(
    'Comprovante de pagamento de boleto\nBeneficiário: F F DISTRIBUIDORA DE PRODUTOS LTDA\n' +
    'Data de vencimento: 05/10/2026\nData do pagamento: 09/10/2026\nValor do documento: R$ 964,62\nValor pago: R$ 964,62',
    'FORNECEDOR F F DISTRIBUIDORA DE PRODUTOS R$ 964,62 V 051026.pdf');
  assert.deepStrictEqual(forn.valores, [96462]);
  assert.deepStrictEqual(forn.vencimentos, ['2026-10-05']);
  assert.deepStrictEqual(forn.datas, ['2026-10-09']);

  // PIX: nome do arquivo com favorecido/descrição, data só no texto do PDF
  const pix = C.dadosComprovante('Pix enviado\n06/10/2026 - 10:42\nValor R$ 490,00\nPara ALANA GONCALVES RODRIGUES',
    'FAVORECIDO ALANA GONCALVES RODRIGUES R$ 490,00 PIX ENVIADO - FOLHA MULTI AGO 26.pdf');
  assert.deepStrictEqual(pix.valores, [49000]);
  assert.deepStrictEqual(pix.datas, ['2026-10-06']);

  const pares = [
    { movimento: { id: 'b1', data: '2026-10-09', valor: -964.62, historico: 'PAG BOLETO' },
      parcela: { nome: 'F F Distribuidora de Produtos', descricao: 'NF 1234', vencimento: '2026-10-05' } },
    { movimento: { id: 'p1', data: '2026-10-06', valor: -490, historico: 'PIX ENVIADO ALANA' },
      parcela: { nome: 'Alana Goncalves Rodrigues', descricao: 'FOLHA MULTI AGO 26', vencimento: '2026-10-05' } }
  ];
  assert.deepStrictEqual(C.casarComprovantes(pares, [{ id: 'f', ...forn }, { id: 'x', ...pix }]), { b1: 'f', p1: 'x' });
});

test('nomeNoExtrato pega o favorecido de PIX/TED e ignora boleto/tarifa', () => {
  assert.strictEqual(C.nomeNoExtrato('DEBITO TRANSFERENCIA PIX ( DOC.: DEB PIX / ROGERIO LIMA DOS SANTOS )'), 'rogerio lima santos');
  assert.strictEqual(C.nomeNoExtrato('TED BETA SERVICOS'), 'beta servicos');
  assert.strictEqual(C.nomeNoExtrato('LIQUIDACAO DE TITULO - IB ( DOC.: 1368293600 / VA EXTRA RIO'), '');
  assert.strictEqual(C.nomeNoExtrato('TARIFA PIX'), '');
  assert.strictEqual(C.nomeNoExtrato('ENEL PAGTO BOLETO'), '');
});

test('PIX com nome diferente não vira sugestão: fica como possível (caso real 16/10)', () => {
  const movs = [
    { id: 'm1', data: '2026-10-16', valor: -323, historico: 'DEBITO TRANSFERENCIA PIX ( DOC.: DEB PIX / ROGERIO LIMA DOS SANTOS )' },
    { id: 'm2', data: '2026-10-16', valor: -200, historico: 'DEBITO TRANSFERENCIA PIX ( DOC.: DEB PIX / THAINA GOULART RIBEIRO )' },
    { id: 'm3', data: '2026-10-16', valor: -150, historico: 'DEBITO TRANSFERENCIA PIX ( DOC.: DEB PIX / MARIA CLARA SOUZA )' }
  ];
  const parcelas = [
    { id: 'p1', tipo: 'pagar', vencimento: '2026-10-16', valor: 323, nome: 'Carlos Roberto de Oliveira Santos', descricao: 'PAGAMENTO PLANTÃO EXTRA' },
    { id: 'p2', tipo: 'pagar', vencimento: '2026-10-19', valor: 200, nome: 'ZELO HEALTH CARE', descricao: 'MATERIAL MEDICO' },
    { id: 'p3', tipo: 'pagar', vencimento: '2026-10-16', valor: 150, nome: 'Maria Clara Souza Lima', descricao: 'PLANTÃO' }
  ];
  const r = C.conciliar(movs, parcelas, { janelaDias: 5 });
  assert.deepStrictEqual(r.pares.map(p => [p.movimento.id, p.parcela.id, p.confianca]), [['m3', 'p3', 'alta']]);
  const sem = Object.fromEntries(r.semParcela.map(m => [m.id, (m.possiveis || []).map(x => x.parcela.id)]));
  assert.deepStrictEqual(sem, { m1: ['p1'], m2: ['p2'] });
});

test('boleto sem nome no extrato, único candidato: sugestão média (conferir)', () => {
  const r = C.conciliar(
    [{ id: 'm', data: '2026-10-16', valor: -485.6, historico: 'LIQUIDACAO DE TITULO - IB ( DOC.: 1368293600 / 0120682000010' }],
    [{ id: 'p', tipo: 'pagar', vencimento: '2026-10-16', valor: 485.6, nome: 'Fornecedor X', descricao: 'NF 10' }],
    { janelaDias: 5 });
  assert.strictEqual(r.pares[0].confianca, 'media');
});

test('juros/multa e desconto: mesmo contato, valor diferente', () => {
  const movs = [
    { id: 'j', data: '2026-10-12', valor: -1030, historico: 'TED ALFA LOCACOES' },   // pagou com atraso
    { id: 'd', data: '2026-10-01', valor: 970, historico: 'PIX RECEBIDO BETA COMERCIO' }, // cliente pagou com desconto
    { id: 'x', data: '2026-10-01', valor: -700, historico: 'TED GAMA LTDA COMERCIO' }  // diferença grande demais
  ];
  const parcelas = [
    { id: 'pj', tipo: 'pagar', vencimento: '2026-10-05', valor: 1000, nome: 'Alfa Locações' },
    { id: 'pd', tipo: 'receber', vencimento: '2026-10-05', valor: 1000, nome: 'Beta Comércio' },
    { id: 'px', tipo: 'pagar', vencimento: '2026-10-01', valor: 1000, nome: 'Gama Comercio' }
  ];
  const r = C.conciliar(movs, parcelas, { janelaDias: 5 });
  const m = Object.fromEntries(r.pares.map(p => [p.movimento.id, [p.parcela.id, p.confianca, p.ajuste]]));
  assert.deepStrictEqual(m.j, ['pj', 'media', { tipo: 'juros', valor: 30 }]);
  assert.deepStrictEqual(m.d, ['pd', 'media', { tipo: 'desconto', valor: 30 }]);
  assert.strictEqual(m.x, undefined);
});

test('montarPar (vínculo manual) calcula dias e ajuste', () => {
  const p = C.montarPar({ id: 'm', data: '2026-10-10', valor: -110 }, { id: 'p', vencimento: '2026-10-05', valor: 100 });
  assert.strictEqual(p.confianca, 'manual');
  assert.strictEqual(p.dias, 5);
  assert.deepStrictEqual(p.ajuste, { tipo: 'juros', valor: 10 });
});

test('comprovante com o nome do contato reforça sugestão média', () => {
  const pares = [{ movimento: { id: 'm', valor: -485.6 }, parcela: { nome: 'Fornecedor Xis' }, confianca: 'media', dias: 0, ajuste: null }];
  const sub = C.reforcarComComprovantes(pares, { m: 'c' }, [{ id: 'c', texto: 'FORNECEDOR XIS R$ 485,60' }]);
  assert.deepStrictEqual(sub, ['m']);
  assert.strictEqual(pares[0].confianca, 'alta');
});

test('resumoFechamento lista baixas, pendências e vencidos', () => {
  const movs = [{ id: 'a', data: '2026-10-16', valor: -100, historico: 'X' }, { id: 'b', data: '2026-10-16', valor: -12.5, historico: 'TARIFA' }];
  const resultado = {
    pares: [{ movimento: movs[0], parcela: { valor: 100 }, ajuste: null }],
    semParcela: [movs[1]],
    parcelasSemMovimento: [{ vencimento: '2026-10-01', valor: 50, tipo: 'receber', nome: 'Cliente Y' }]
  };
  const t = C.resumoFechamento({ cliente: 'Clínica', de: '2026-10-16', ate: '2026-10-16', movimentos: movs, resultado,
    retornos: { a: { status: 'ok' } }, hoje: '2026-10-17' });
  assert.match(t, /Baixados no Conta Azul: 1 \(R\$ 100,00\)/);
  assert.match(t, /sem lançamento: 1 \(R\$ 12,50\)/);
  assert.match(t, /Vencidos .*: 1 \(R\$ 50,00\)/);
});

test('cópia do motor na skill está igual à do robô', () => {
  const fs = require('fs');
  const path = require('path');
  const ler = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  assert.strictEqual(ler('.claude/skills/conciliacao-conta-azul/scripts/conciliacao-core.js'), ler('conciliacao-core.js'),
    'Copie conciliacao-core.js para .claude/skills/conciliacao-conta-azul/scripts/');
});
