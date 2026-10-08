import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';
import { invalido } from '../saas/erros.js';

// Impede que clientes façam o servidor acessar a rede interna (SSRF) por meio de
// webhooks ou de URLs de prefeitura cadastradas. Ativo em produção; pode ser
// forçado com BLOQUEAR_REDE_PRIVADA=true|false.

function privado(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return privado(x.slice(7));
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}

export function bloqueioAtivo() {
  const v = process.env.BLOQUEAR_REDE_PRIVADA;
  return v ? v === 'true' : config.producao;
}

export async function exigirEnderecoPublico(url) {
  if (!bloqueioAtivo()) return;
  let host;
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { throw invalido('URL inválida.'); }
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((r) => r.address);
  if (!ips.length) throw invalido(`Não foi possível resolver o endereço ${host}.`);
  if (ips.some(privado)) throw invalido('Endereços internos ou privados não são permitidos.');
}

export const _privado = privado; // para testes
