import { ErroApp } from './erros.js';

// Limite de tentativas em memória (janela deslizante). Com várias instâncias,
// troque por Redis mantendo a mesma função.
const baldes = new Map();

export function limitar(chave, { max, janelaMs }) {
  const agora = Date.now();
  const lista = (baldes.get(chave) || []).filter((t) => agora - t < janelaMs);
  if (lista.length >= max) {
    const espera = Math.ceil((janelaMs - (agora - lista[0])) / 1000);
    throw new ErroApp(429, `Muitas tentativas. Tente novamente em ${espera} s.`);
  }
  lista.push(agora);
  baldes.set(chave, lista);
}

export function limparLimites() {
  baldes.clear();
}

setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of baldes) if (!v.some((t) => agora - t < 3600_000)) baldes.delete(k);
}, 600_000).unref();
