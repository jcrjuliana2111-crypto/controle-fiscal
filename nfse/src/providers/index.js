import { nacional } from './nacional.js';
import { abrasf, PRESETS } from './abrasf.js';
import { saoPaulo } from './sao-paulo.js';

export const PROVEDORES = { nacional, abrasf, 'sao-paulo': saoPaulo };
export { PRESETS };

export function provedor(id) {
  const p = PROVEDORES[id];
  if (!p) throw new Error(`Provedor de NFS-e desconhecido: ${id}`);
  return p;
}
