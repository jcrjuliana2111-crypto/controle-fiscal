import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { q, um, varios } from '../db/pool.js';
import { invalido } from '../saas/erros.js';
import { PROVEDORES, PRESETS } from '../providers/index.js';

let arquivo = null;
function doArquivo() {
  if (!arquivo) {
    arquivo = JSON.parse(fs.readFileSync(path.join(config.raiz, 'data', 'municipios.json'), 'utf8'));
    delete arquivo._comentario;
  }
  return arquivo;
}

const deLinha = (r) => r && ({ nome: r.nome, uf: r.uf, provedor: r.provedor, preset: r.preset, urls: r.urls || {}, opcoes: r.opcoes, observacao: r.observacao, origem: r.conta_id ? 'conta' : 'plataforma' });

/**
 * Prioridade: configuração da conta > configuração global da plataforma >
 * data/municipios.json > Padrão Nacional.
 */
export async function resolverMunicipio(contaId, codigo, forcarProvedor) {
  const linhas = await varios('SELECT * FROM municipios WHERE codigo = $1 AND (conta_id = $2 OR conta_id IS NULL) ORDER BY conta_id NULLS LAST', [String(codigo), contaId]);
  const m = deLinha(linhas[0]) || (doArquivo()[codigo] ? { ...doArquivo()[codigo], origem: 'padrao' } : null);
  const provedor = forcarProvedor && forcarProvedor !== 'auto' ? forcarProvedor : (m?.provedor || 'nacional');
  return { codigo: String(codigo), ...(m || {}), provedorEfetivo: provedor };
}

export async function listarMunicipios(contaId) {
  const out = {};
  for (const [cod, m] of Object.entries(doArquivo())) out[cod] = { ...m, origem: 'padrao' };
  for (const r of await varios('SELECT * FROM municipios WHERE conta_id IS NULL OR conta_id = $1 ORDER BY conta_id NULLS FIRST', [contaId]))
    out[r.codigo] = deLinha(r);
  return out;
}

function validar(codigo, d) {
  if (!/^\d{7}$/.test(codigo)) throw invalido('Código IBGE deve ter 7 dígitos.');
  if (!d.nome?.trim()) throw invalido('Informe o nome do município.');
  if (!PROVEDORES[d.provedor]) throw invalido('Provedor inválido.');
  if (d.provedor === 'abrasf' && d.preset && !PRESETS[d.preset]) throw invalido('Leiaute ABRASF inválido.');
  for (const u of Object.values(d.urls || {})) if (u && !/^https?:\/\//.test(u)) throw invalido('URLs devem começar com https://');
}

/** contaId = null grava a configuração global (somente superadmin). */
export async function salvarMunicipio(contaId, codigo, d) {
  validar(codigo, d);
  const valores = [codigo, contaId, d.nome.trim(), d.uf || null, d.provedor, d.preset || null, JSON.stringify(d.urls || {}), d.opcoes ? JSON.stringify(d.opcoes) : null, d.observacao || null];
  const existe = await um(`SELECT 1 FROM municipios WHERE codigo = $1 AND conta_id IS NOT DISTINCT FROM $2`, [codigo, contaId]);
  if (existe) {
    await q(`UPDATE municipios SET nome = $3, uf = $4, provedor = $5, preset = $6, urls = $7, opcoes = $8, observacao = $9, atualizado_em = now()
             WHERE codigo = $1 AND conta_id IS NOT DISTINCT FROM $2`, valores);
  } else {
    await q(`INSERT INTO municipios (codigo, conta_id, nome, uf, provedor, preset, urls, opcoes, observacao) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, valores);
  }
}

export async function removerMunicipio(contaId, codigo) {
  await q('DELETE FROM municipios WHERE codigo = $1 AND conta_id IS NOT DISTINCT FROM $2', [codigo, contaId]);
}
