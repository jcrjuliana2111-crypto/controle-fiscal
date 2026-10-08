// Cálculos de ISS, retenções e valor líquido. Tudo em centavos inteiros para
// evitar erros de ponto flutuante.

const c = (v) => Math.round(Number(v || 0) * 100);
const r = (cent) => cent / 100;

export function calcular(valores = {}) {
  const vServ = c(valores.servico);
  const descInc = c(valores.descontoIncondicionado);
  const descCond = c(valores.descontoCondicionado);
  const deducoes = c(valores.deducoes);
  const aliquota = Number(valores.aliquotaIss || 0); // em %

  const base = Math.max(0, vServ - descInc - deducoes);
  const iss = Math.round((base * aliquota) / 100);
  const issRetido = valores.issRetido ? iss : 0;

  const pis = c(valores.pis), cofins = c(valores.cofins), inss = c(valores.inss);
  const ir = c(valores.ir), csll = c(valores.csll), outras = c(valores.outrasRetencoes);
  // PIS/COFINS só reduzem o líquido quando retidos pelo tomador.
  const pisCofinsRetido = valores.pisCofinsRetido ? pis + cofins : 0;
  const retencoesFederais = inss + ir + csll + pisCofinsRetido;

  const liquido = vServ - descInc - descCond - retencoesFederais - outras - issRetido;

  return {
    valorServico: r(vServ),
    descontoIncondicionado: r(descInc),
    descontoCondicionado: r(descCond),
    deducoes: r(deducoes),
    baseCalculo: r(base),
    aliquotaIss: aliquota,
    valorIss: r(iss),
    valorIssRetido: r(issRetido),
    retencoesFederais: r(retencoesFederais),
    outrasRetencoes: r(outras),
    valorLiquido: r(liquido),
  };
}
