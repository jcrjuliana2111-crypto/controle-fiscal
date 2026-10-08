import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../store/db.js';

let base = null;
function registroBase() {
  if (!base) {
    const raw = JSON.parse(fs.readFileSync(path.join(config.raiz, 'data', 'municipios.json'), 'utf8'));
    delete raw._comentario;
    base = raw;
  }
  return base;
}

/** Registro efetivo: arquivo versionado + cadastros feitos pela tela. */
export function listarMunicipios() {
  return { ...registroBase(), ...db.get().municipios };
}

/**
 * Define qual provedor atende o município. Padrão: NFS-e Nacional, que desde
 * 2026 é o leiaute de referência obrigatório (LC 214/2025) para os municípios.
 */
export function resolverMunicipio(codigoIbge, forcarProvedor) {
  const m = listarMunicipios()[String(codigoIbge)] || null;
  const provedor = forcarProvedor && forcarProvedor !== 'auto' ? forcarProvedor : (m?.provedor || 'nacional');
  return { codigo: String(codigoIbge), provedor, ...(m || {}), provedorEfetivo: provedor };
}

export function salvarMunicipio(codigo, dados) {
  if (!/^\d{7}$/.test(codigo)) throw new Error('Código IBGE deve ter 7 dígitos.');
  db.update((d) => { d.municipios[codigo] = { ...dados }; });
}

export function removerMunicipio(codigo) {
  db.update((d) => { delete d.municipios[codigo]; });
}
