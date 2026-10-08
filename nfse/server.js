import express from 'express';
import path from 'node:path';
import { config } from './src/config.js';
import rotas from './src/api/rotas.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Permite que o painel de notificações (index.html, outro domínio) abra o emissor.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', process.env.NFSE_CORS_ORIGIN || '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use('/api', rotas);
app.use(express.static(path.join(config.raiz, 'public')));

if (config.secret === 'troque-esta-chave-em-producao') {
  console.warn('[nfse] AVISO: defina NFSE_SECRET — é a chave que protege os certificados gravados em disco.');
}

app.listen(config.porta, config.host, () => {
  console.log(`[nfse] Emissor de NFS-e em http://${config.host}:${config.porta}`);
});
