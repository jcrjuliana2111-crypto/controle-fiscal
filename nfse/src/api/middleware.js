import crypto from 'node:crypto';
import { config } from '../config.js';
import { sessaoPorToken, chavePorToken, papelNaConta } from '../saas/contas.js';
import { um } from '../db/pool.js';
import { pode } from '../saas/planos.js';
import { ErroApp } from '../saas/erros.js';
import { limitar } from '../saas/limitador.js';

export const COOKIE = config.producao ? '__Host-sid' : 'sid';

export function lerCookies(req) {
  const out = {};
  for (const par of (req.headers.cookie || '').split(';')) {
    const i = par.indexOf('=');
    if (i > 0) out[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
  }
  return out;
}

export function gravarSessao(res, token, maxAge) {
  res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.producao ? '; Secure' : ''}`);
}

export function apagarSessao(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.producao ? '; Secure' : ''}`);
}

export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function ipDe(req) {
  return req.ip || req.socket.remoteAddress;
}

/**
 * Identifica quem está chamando: chave de API (Authorization: Bearer nfk_...)
 * ou sessão do navegador (cookie). Preenche req.quem.
 */
export const identificar = h(async (req, res, next) => {
  const bearer = (req.get('authorization') || '').match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer) {
    const k = await chavePorToken(bearer);
    if (!k) throw new ErroApp(401, 'Chave de API inválida ou revogada.');
    limitar(`api:${k.conta_id}`, { max: 600, janelaMs: 60_000 });
    req.quem = { contaId: k.conta_id, chaveApiId: k.id, papel: k.papel, ip: ipDe(req), viaApi: true };
    return next();
  }
  const token = lerCookies(req)[COOKIE];
  const s = token && (await sessaoPorToken(token));
  if (!s) { req.quem = null; return next(); }

  // Proteção CSRF: chamadas que alteram dados precisam do cabeçalho enviado pelo nosso front-end.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-requested-with') !== 'fetch')
    throw new ErroApp(403, 'Requisição bloqueada (CSRF).');

  let contaId = s.conta_id;
  let papel = contaId && (await papelNaConta(s.id, contaId));
  if (!papel) {
    const m = await um('SELECT conta_id, papel FROM membros WHERE usuario_id = $1 ORDER BY criado_em LIMIT 1', [s.id]);
    contaId = m?.conta_id || null;
    papel = m?.papel || null;
  }
  req.quem = { contaId, usuarioId: s.id, papel, sessaoId: s.sessao_id, usuario: s, ip: ipDe(req), token };
  next();
});

export function exigirLogin(req, res, next) {
  if (!req.quem) return next(new ErroApp(401, 'Faça login para continuar.'));
  next();
}

export function exigirConta(req, res, next) {
  if (!req.quem) return next(new ErroApp(401, 'Faça login para continuar.'));
  if (!req.quem.contaId) return next(new ErroApp(403, 'Você não faz parte de nenhuma conta.'));
  next();
}

export const exigir = (permissao) => (req, res, next) => {
  if (!req.quem?.contaId) return next(new ErroApp(401, 'Faça login para continuar.'));
  if (!pode(req.quem.papel, permissao)) return next(new ErroApp(403, 'Seu perfil de acesso não permite esta ação.'));
  next();
};

export function exigirSuperadmin(req, res, next) {
  if (!req.quem?.usuario?.superadmin) return next(new ErroApp(403, 'Acesso restrito à administração da plataforma.'));
  next();
}

export function idRequisicao(req, res, next) {
  req.id = req.get('x-request-id') || crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  const inicio = Date.now();
  res.on('finish', () => {
    if (process.env.NODE_TEST_CONTEXT || !req.path.startsWith('/api')) return;
    console.log(JSON.stringify({ t: new Date().toISOString(), id: req.id, metodo: req.method, rota: req.path, status: res.statusCode, ms: Date.now() - inicio, conta: req.quem?.contaId }));
  });
  next();
}

export function cabecalhosSeguranca(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://viacep.com.br; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  if (config.producao) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

export function tratarErros(err, req, res, next) {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ erro: 'Conteúdo grande demais.' });
  const status = err.status || 500;
  if (status >= 500) console.error(`[erro ${req.id}]`, err);
  res.status(status).json({
    erro: status >= 500 ? `Erro interno. Código para suporte: ${req.id}` : err.message,
    ...(err.erros ? { erros: err.erros } : {}),
  });
}
