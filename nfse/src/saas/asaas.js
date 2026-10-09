import { config } from '../config.js';
import { ErroApp } from './erros.js';

// Cliente mínimo da API v3 do Asaas (https://docs.asaas.com).
export async function asaas(caminho, { metodo = 'GET', corpo } = {}) {
  if (!config.asaas.chave) throw new ErroApp(503, 'Pagamento online indisponível no momento. Fale com o suporte.');
  let r;
  try {
    r = await fetch(config.asaas.url + caminho, {
      method: metodo,
      headers: {
        'Content-Type': 'application/json',
        access_token: config.asaas.chave,
        'User-Agent': `${config.nomeApp}/1.0`,
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new ErroApp(502, 'Não foi possível falar com o Asaas agora. Tente de novo em instantes.');
  }
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (dados.errors || []).map((e) => e.description).join(' ') || `Asaas respondeu HTTP ${r.status}.`;
    throw new ErroApp(r.status >= 500 ? 502 : 422, msg);
  }
  return dados;
}
