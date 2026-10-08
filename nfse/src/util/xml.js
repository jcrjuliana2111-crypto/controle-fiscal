// Helpers para montar XML "na mão" já em forma canônica (sem tags auto-fechadas,
// sem espaços entre elementos), o que simplifica a assinatura XMLDSig.

/** Escapa conteúdo de texto exatamente como a C14N o representa (aspas ficam literais). */
export function esc(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#xD;');
}

/** <nome>valor</nome> — omitido quando o valor é vazio/nulo. */
export function tag(nome, valor) {
  if (valor === undefined || valor === null || valor === '') return '';
  return `<${nome}>${esc(valor)}</${nome}>`;
}

/** <nome>conteudo</nome> — conteúdo já em XML; omitido quando vazio. */
export function grupo(nome, conteudo, attrs = '') {
  if (!conteudo) return '';
  return `<${nome}${attrs ? ' ' + attrs : ''}>${conteudo}</${nome}>`;
}

export function onlyDigits(v) {
  return String(v ?? '').replace(/\D/g, '');
}

/** CNPJ (inclusive alfanumérico, IN RFB 2.229/2024) ou CPF normalizado. */
export function normDoc(v) {
  return String(v ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Valor monetário com 2 casas e ponto decimal. */
export function money(v) {
  return (Math.round(Number(v || 0) * 100) / 100).toFixed(2);
}

/** Número decimal sem zeros à direita desnecessários (ex.: alíquotas). */
export function dec(v, casas = 2) {
  return Number(Number(v || 0).toFixed(casas)).toFixed(casas);
}

/** Remove acentos/caracteres de controle que alguns provedores rejeitam. */
export function limparTexto(v, max) {
  let s = String(v ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

export function semAcento(v) {
  return String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Data/hora no fuso de Brasília (UTC-3, sem horário de verão desde 2019),
 * no formato AAAA-MM-DDThh:mm:ss-03:00.
 */
export function dataHoraBrasilia(date = new Date()) {
  const d = new Date(date.getTime() - 3 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}-03:00`;
}

export function hojeBrasilia(date = new Date()) {
  return dataHoraBrasilia(date).slice(0, 10);
}
