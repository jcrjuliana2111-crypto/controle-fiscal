import express from 'express';
import * as contas from '../saas/contas.js';
import { auditar } from '../saas/auditoria.js';
import { limitar } from '../saas/limitador.js';
import { h, ipDe, gravarSessao, apagarSessao, exigirLogin } from './middleware.js';

const r = express.Router();
const ctxDe = (req, extra = {}) => ({ ip: ipDe(req), userAgent: req.get('user-agent'), ...extra });

r.post('/cadastro', h(async (req, res) => {
  limitar(`cadastro:${ipDe(req)}`, { max: 5, janelaMs: 3600_000 });
  const { usuario, conta } = await contas.cadastrar(req.body || {});
  const s = await contas.criarSessao(usuario.id, ctxDe(req, { contaId: conta.id }));
  gravarSessao(res, s.token, s.maxAge);
  await auditar({ contaId: conta.id, usuarioId: usuario.id, ip: ipDe(req) }, 'conta.criar', conta.id);
  res.status(201).json(await contas.resumoUsuario(usuario, conta.id));
}));

r.post('/entrar', h(async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  limitar(`login:${ipDe(req)}`, { max: 30, janelaMs: 900_000 });
  limitar(`login:${email}`, { max: 8, janelaMs: 900_000 });
  const u = await contas.autenticar({ email, senha: req.body?.senha });
  const s = await contas.criarSessao(u.id, ctxDe(req));
  gravarSessao(res, s.token, s.maxAge);
  await auditar({ usuarioId: u.id, ip: ipDe(req) }, 'usuario.login', u.id);
  res.json({ ok: true });
}));

r.post('/sair', h(async (req, res) => {
  if (req.quem?.token) await contas.encerrarSessao(req.quem.token);
  apagarSessao(res);
  res.json({ ok: true });
}));

r.get('/eu', exigirLogin, h(async (req, res) => {
  if (req.quem.viaApi) return res.json({ conta: await contas.situacaoConta(req.quem.contaId), papel: req.quem.papel, viaApi: true });
  res.json(await contas.resumoUsuario(req.quem.usuario, req.quem.contaId));
}));

r.post('/conta-ativa', exigirLogin, h(async (req, res) => {
  await contas.trocarConta(req.quem.sessaoId, req.quem.usuarioId, req.body?.contaId);
  res.json({ ok: true });
}));

r.post('/senha', exigirLogin, h(async (req, res) => {
  await contas.trocarSenha(req.quem.usuarioId, req.body?.atual, req.body?.nova);
  await auditar(req.quem, 'usuario.trocar_senha', req.quem.usuarioId);
  res.json({ ok: true });
}));

r.post('/esqueci', h(async (req, res) => {
  limitar(`esqueci:${ipDe(req)}`, { max: 5, janelaMs: 3600_000 });
  await contas.esqueciSenha(String(req.body?.email || '').trim());
  res.json({ ok: true, mensagem: 'Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.' });
}));

r.post('/redefinir', h(async (req, res) => {
  limitar(`redefinir:${ipDe(req)}`, { max: 10, janelaMs: 3600_000 });
  const usuarioId = await contas.redefinirSenha(req.body?.token, req.body?.senha);
  const s = await contas.criarSessao(usuarioId, ctxDe(req));
  gravarSessao(res, s.token, s.maxAge);
  res.json({ ok: true });
}));

r.post('/verificar', h(async (req, res) => {
  await contas.verificarEmail(req.body?.token);
  res.json({ ok: true });
}));

r.get('/convite/:token', h(async (req, res) => res.json(await contas.infoConvite(req.params.token))));

r.post('/convite/:token/aceitar', h(async (req, res) => {
  limitar(`convite:${ipDe(req)}`, { max: 10, janelaMs: 3600_000 });
  const { usuario, contaId } = await contas.aceitarConvite(req.params.token, { ...req.body, usuarioLogado: req.quem?.usuarioId });
  if (req.quem?.sessaoId) await contas.trocarConta(req.quem.sessaoId, usuario.id, contaId);
  else {
    const s = await contas.criarSessao(usuario.id, ctxDe(req, { contaId }));
    gravarSessao(res, s.token, s.maxAge);
  }
  await auditar({ contaId, usuarioId: usuario.id, ip: ipDe(req) }, 'equipe.aceitar_convite', usuario.id);
  res.json({ ok: true });
}));

export default r;
