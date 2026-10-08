import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  raiz,
  porta: Number(process.env.PORT || 3333),
  host: process.env.HOST || '127.0.0.1',
  dataDir: path.resolve(process.env.NFSE_DATA_DIR || path.join(raiz, 'data')),
  // Chave usada para cifrar certificados e senhas em disco. Defina em produção!
  secret: process.env.NFSE_SECRET || 'troque-esta-chave-em-producao',
  // Token exigido no header Authorization: Bearer <token>. Vazio = sem autenticação.
  apiToken: process.env.NFSE_API_TOKEN || '',
  verAplic: 'ControleFiscal-1.0',
};
