import { normDoc, onlyDigits } from '../util/xml.js';

// CNPJ numérico ou alfanumérico (a partir de jul/2026). Cada caractere vale
// (código ASCII - 48), o que para dígitos dá o próprio valor.
export function cnpjValido(v) {
  const s = normDoc(v);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(s) || /^(.)\1{13}$/.test(s)) return false;
  const val = (ch) => ch.charCodeAt(0) - 48;
  const dv = (len) => {
    let soma = 0, peso = 2;
    for (let i = len - 1; i >= 0; i--) {
      soma += val(s[i]) * peso;
      peso = peso === 9 ? 2 : peso + 1;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return dv(12) === Number(s[12]) && dv(13) === Number(s[13]);
}

export function cpfValido(v) {
  const s = onlyDigits(v);
  if (s.length !== 11 || /^(\d)\1{10}$/.test(s)) return false;
  const dv = (len) => {
    let soma = 0;
    for (let i = 0; i < len; i++) soma += Number(s[i]) * (len + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return dv(9) === Number(s[9]) && dv(10) === Number(s[10]);
}

export function documentoValido(v) {
  const s = normDoc(v);
  return s.length === 11 ? cpfValido(s) : cnpjValido(s);
}

/**
 * Validações de negócio comuns a todos os provedores. Retorna lista de erros
 * (vazia = ok). Cada provedor pode acrescentar regras próprias.
 */
export function validarNota(nota, prestador) {
  const erros = [];
  const add = (campo, msg) => erros.push({ campo, mensagem: msg });

  if (!prestador) add('prestador', 'Prestador não encontrado.');
  else {
    if (!documentoValido(prestador.documento)) add('prestador.documento', 'CNPJ/CPF do prestador inválido.');
    if (!/^\d{7}$/.test(String(prestador.codigoMunicipio || ''))) add('prestador.codigoMunicipio', 'Código IBGE do município do prestador deve ter 7 dígitos.');
  }

  const t = nota.tomador || {};
  if (t.tipo !== 'NI') {
    if (t.tipo === 'EXT') {
      if (!t.nif && !t.motivoSemNif) add('tomador.nif', 'Tomador estrangeiro: informe o NIF ou o motivo de não informá-lo.');
    } else if (!documentoValido(t.documento)) add('tomador.documento', 'CNPJ/CPF do tomador inválido.');
    if (!t.nome) add('tomador.nome', 'Informe o nome/razão social do tomador.');
  }

  const s = nota.servico || {};
  if (!s.discriminacao || s.discriminacao.trim().length < 3) add('servico.discriminacao', 'Descreva o serviço prestado.');

  const v = nota.valores || {};
  if (!(Number(v.servico) > 0)) add('valores.servico', 'Valor do serviço deve ser maior que zero.');
  const aliq = Number(v.aliquotaIss || 0);
  if (aliq < 0 || aliq > 5) add('valores.aliquotaIss', 'Alíquota de ISS não pode ser negativa nem superar 5% (LC 116/2003).');
  if (Number(v.descontoIncondicionado || 0) + Number(v.deducoes || 0) > Number(v.servico || 0))
    add('valores', 'Descontos/deduções não podem superar o valor do serviço.');

  if (nota.competencia && !/^\d{4}-\d{2}-\d{2}$/.test(nota.competencia)) add('competencia', 'Competência inválida (AAAA-MM-DD).');
  return erros;
}
