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

test('casarComprovantes liga por valor, data e nome', () => {
  const pares = [
    { movimento: { id: 'm1', data: '2026-10-01', valor: -500, historico: 'PIX ENVIADO' }, parcela: { nome: 'Alfa Ltda' } },
    { movimento: { id: 'm2', data: '2026-10-01', valor: -500, historico: 'PIX ENVIADO' }, parcela: { nome: 'Beta SA' } },
    { movimento: { id: 'm3', data: '2026-10-05', valor: 80, historico: 'TED' }, parcela: { nome: 'Gama' } }
  ];
  const comps = [
    { id: 'c1', valor: 500, data: '2026-10-01', nome: 'BETA SA' },
    { id: 'c2', valor: 500, data: '2026-10-02', nome: 'ALFA LTDA' },
    { id: 'c3', valor: 80, data: '2026-10-20', nome: 'Gama' } // fora da janela
  ];
  assert.deepStrictEqual(C.casarComprovantes(pares, comps, { janelaDias: 3 }), { m1: 'c2', m2: 'c1' });
});
