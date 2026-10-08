import { q, um, varios } from '../db/pool.js';
import { ErroApp, invalido, naoEncontrado } from '../saas/erros.js';
import { situacaoConta } from '../saas/contas.js';
import { lerCertificado, certificadoVencido } from './certificado.js';
import { documentoValido } from './validacao.js';
import { cifrar, decifrar, novaChaveDados, abrirChaveDados } from '../util/segredo.js';
import { normDoc } from '../util/xml.js';

// Campos guardados em "dados" (jsonb).
const EXTRAS = ['nomeFantasia', 'email', 'fone', 'opSimpNac', 'regApTribSN', 'regEspTrib', 'incentivoFiscal',
  'aliquotaPadrao', 'itemListaPadrao', 'codigoTributacaoNacionalPadrao', 'endereco'];

/** Linha do banco -> objeto usado pela aplicação e pelos provedores. */
export function deLinha(r, { comSegredos = false } = {}) {
  if (!r) return null;
  const p = {
    id: r.id, contaId: r.conta_id, razaoSocial: r.razao_social, documento: r.documento,
    inscricaoMunicipal: r.inscricao_municipal, codigoMunicipio: r.codigo_municipio, municipio: r.municipio, uf: r.uf,
    ambiente: r.ambiente, provedor: r.provedor, serie: r.serie, proximoNumero: r.proximo_numero,
    opSimpNac: 1, regEspTrib: 0, ...r.dados,
    certificado: r.certificado, atualizadoEm: r.atualizado_em,
  };
  if (comSegredos) Object.assign(p, { _pfx: r.cert_pfx, _senha: r.cert_senha, _chave: r.cert_chave });
  return p;
}

export async function listarPrestadores(contaId) {
  return (await varios('SELECT * FROM prestadores WHERE conta_id = $1 AND ativo ORDER BY razao_social', [contaId])).map((r) => deLinha(r));
}

export async function obterPrestador(contaId, id, opts) {
  const r = await um('SELECT * FROM prestadores WHERE id = $1 AND conta_id = $2 AND ativo', [id, contaId]);
  if (!r) throw naoEncontrado('Prestador');
  return deLinha(r, opts);
}

function normalizar(d) {
  const documento = normDoc(d.documento);
  if (!documentoValido(documento)) throw invalido('CNPJ/CPF do prestador inválido.');
  if (!d.razaoSocial?.trim()) throw invalido('Informe a razão social.');
  if (!/^\d{7}$/.test(String(d.codigoMunicipio || ''))) throw invalido('Código IBGE do município deve ter 7 dígitos.');
  if (d.ambiente && !['homologacao', 'producao'].includes(d.ambiente)) throw invalido('Ambiente inválido.');
  const prox = Number(d.proximoNumero || 1);
  if (!Number.isInteger(prox) || prox < 1) throw invalido('Próximo número deve ser um inteiro positivo.');
  if (!/^[0-9A-Za-z]{1,5}$/.test(String(d.serie || '1'))) throw invalido('Série deve ter de 1 a 5 caracteres alfanuméricos.');
  const dados = Object.fromEntries(EXTRAS.filter((k) => d[k] !== undefined && d[k] !== '').map((k) => [k, d[k]]));
  return {
    razao_social: d.razaoSocial.trim(), documento, inscricao_municipal: d.inscricaoMunicipal || null,
    codigo_municipio: String(d.codigoMunicipio), municipio: d.municipio || null, uf: (d.uf || '').toUpperCase() || null,
    ambiente: d.ambiente || 'homologacao', provedor: d.provedor || 'auto', serie: String(d.serie || '1'), proximo_numero: prox, dados,
  };
}

export async function criarPrestador(contaId, d) {
  const sit = await situacaoConta(contaId);
  if (sit.uso.prestadores >= sit.limites.prestadores)
    throw new ErroApp(402, `Seu plano permite ${sit.limites.prestadores} empresa(s) emitente(s). Faça upgrade para cadastrar mais.`);
  const n = normalizar(d);
  try {
    const r = await um(`INSERT INTO prestadores (conta_id, razao_social, documento, inscricao_municipal, codigo_municipio, municipio, uf, ambiente, provedor, serie, proximo_numero, dados)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [contaId, n.razao_social, n.documento, n.inscricao_municipal, n.codigo_municipio, n.municipio, n.uf, n.ambiente, n.provedor, n.serie, n.proximo_numero, n.dados]);
    return deLinha(r);
  } catch (e) {
    if (e.code === '23505') throw new ErroApp(409, 'Já existe um prestador com este CNPJ/CPF neste município.');
    throw e;
  }
}

export async function atualizarPrestador(contaId, id, d) {
  const atual = await obterPrestador(contaId, id);
  const n = normalizar({ ...atual, ...d });
  if (n.ambiente === 'producao') {
    const sit = await situacaoConta(contaId);
    if (sit.testeExpirado) throw new ErroApp(402, 'Seu período de teste terminou. Assine um plano para emitir em produção.');
  }
  const r = await um(`UPDATE prestadores SET razao_social = $3, documento = $4, inscricao_municipal = $5, codigo_municipio = $6, municipio = $7,
      uf = $8, ambiente = $9, provedor = $10, serie = $11, proximo_numero = $12, dados = $13, atualizado_em = now()
      WHERE id = $1 AND conta_id = $2 RETURNING *`,
  [id, contaId, n.razao_social, n.documento, n.inscricao_municipal, n.codigo_municipio, n.municipio, n.uf, n.ambiente, n.provedor, n.serie, n.proximo_numero, n.dados]);
  cache.delete(id);
  return deLinha(r);
}

export async function desativarPrestador(contaId, id) {
  // Mantém o registro (as notas apontam para ele) e descarta o certificado.
  await q(`UPDATE prestadores SET ativo = false, cert_pfx = NULL, cert_senha = NULL, cert_chave = NULL, atualizado_em = now()
           WHERE id = $1 AND conta_id = $2`, [id, contaId]);
  cache.delete(id);
}

export async function instalarCertificado(contaId, id, pfx, senha) {
  const p = await obterPrestador(contaId, id);
  let info;
  try { info = lerCertificado(pfx, senha); } catch (e) { throw invalido(e.message); }
  if (certificadoVencido(info)) throw invalido(`Certificado vencido em ${info.validoAte.slice(0, 10)}.`);
  const raiz = (s) => normDoc(s).slice(0, 8);
  const aviso = info.documento && raiz(info.documento) !== raiz(p.documento)
    ? `O certificado pertence ao documento ${info.documento}, diferente do prestador.` : '';
  const { dek, dekCifrada } = novaChaveDados();
  const meta = { titular: info.titular, documento: info.documento, emissor: info.emissor, validoDe: info.validoDe, validoAte: info.validoAte, aviso };
  const r = await um(`UPDATE prestadores SET certificado = $3, cert_pfx = $4, cert_senha = $5, cert_chave = $6, atualizado_em = now()
      WHERE id = $1 AND conta_id = $2 RETURNING *`, [id, contaId, meta, cifrar(pfx, dek), cifrar(senha, dek), dekCifrada]);
  cache.delete(id);
  return deLinha(r);
}

// Certificados abertos ficam em memória por alguns minutos (evita decifrar a cada nota).
const cache = new Map();
export function carregarCertificado(p) {
  if (!p._pfx) return null;
  const c = cache.get(p.id);
  if (c && c.versao === String(p.atualizadoEm) && c.expira > Date.now()) return c.cert;
  const dek = abrirChaveDados(p._chave);
  const cert = lerCertificado(decifrar(p._pfx, dek), decifrar(p._senha, dek).toString('utf8'));
  cache.set(p.id, { cert, versao: String(p.atualizadoEm), expira: Date.now() + 10 * 60_000 });
  return cert;
}

/** Certificados que vencem em até N dias (para alertas). */
export async function certificadosVencendo(contaId, dias = 30) {
  return varios(`SELECT id, razao_social, (certificado->>'validoAte') AS valido_ate FROM prestadores
    WHERE conta_id = $1 AND ativo AND certificado IS NOT NULL AND (certificado->>'validoAte')::timestamptz < now() + make_interval(days => $2)
    ORDER BY valido_ate`, [contaId, dias]);
}
