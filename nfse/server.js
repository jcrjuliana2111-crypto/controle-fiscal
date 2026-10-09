import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config, validarConfig } from './src/config.js';
import { pool } from './src/db/pool.js';
import { migrar } from './src/db/migrar.js';
import { iniciarWorkerWebhooks } from './src/saas/webhooks.js';
import { iniciarRotinaCobranca } from './src/saas/cobranca.js';
import { iniciarRotinaCertificados } from './src/saas/certificados.js';
import { iniciarRotinaIntegra } from './src/integra/servico.js';
import rotasAuth from './src/api/rotas-auth.js';
import rotasApp from './src/api/rotas-app.js';
import rotasAdmin from './src/api/rotas-admin.js';
import { identificar, idRequisicao, cabecalhosSeguranca, tratarErros } from './src/api/middleware.js';

export function criarApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1)); // atrás de nginx/Caddy/load balancer
  app.use(idRequisicao, cabecalhosSeguranca);

  app.get('/saude', async (req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });

  const api = express.Router();
  api.use(express.json({ limit: '1mb' }), identificar);
  api.use('/auth', rotasAuth);
  api.use('/admin', rotasAdmin);
  api.use('/', rotasApp);
  api.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));
  api.use(tratarErros);
  app.use('/api/v1', api);

  // Páginas: troca %APP_NAME% pelo nome configurado.
  const pub = path.join(config.raiz, 'public');
  const cache = new Map();
  app.get(['/', '/*.html'], (req, res, next) => {
    const arq = req.path === '/' ? 'index.html' : path.basename(req.path);
    const p = path.join(pub, arq);
    if (!fs.existsSync(p)) return next();
    if (!cache.has(arq) || !config.producao) cache.set(arq, fs.readFileSync(p, 'utf8').replaceAll('%APP_NAME%', config.nomeApp).replaceAll('%APP_URL%', config.urlApp));
    res.type('html').set('Cache-Control', 'no-cache').send(cache.get(arq));
  });
  app.use(express.static(pub, { index: false, maxAge: config.producao ? '1h' : 0 }));
  return app;
}

async function iniciar() {
  validarConfig();
  if (!config.chaveMestra) console.warn('[nfse] AVISO: NFSE_MASTER_KEY não definida — usando chave de desenvolvimento.');
  await migrar();
  iniciarWorkerWebhooks();
  iniciarRotinaCobranca();
  iniciarRotinaCertificados();
  iniciarRotinaIntegra();
  const srv = criarApp().listen(config.porta, config.host, () => console.log(`[nfse] ${config.nomeApp} em ${config.urlApp}`));
  const parar = () => { srv.close(() => pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(0), 10_000).unref(); };
  process.on('SIGTERM', parar);
  process.on('SIGINT', parar);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  iniciar().catch((e) => { console.error(e.message); process.exit(1); });
}
