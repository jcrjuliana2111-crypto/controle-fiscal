import { q, um, varios, transacao } from '../db/pool.js';
import { config } from '../config.js';
import { hashSenha, conferirSenha, novoToken, hashToken } from '../util/segredo.js';
import { ErroApp, invalido, naoEncontrado, proibido } from './erros.js';
import { enviarEmail } from './email.js';
import { plano, PAPEIS } from './planos.js';

const DIAS_SESSAO = 14;
const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || ''));

function conferirSenhaForte(senha) {
  if (String(senha || '').length < 8) throw invalido('A senha deve ter pelo menos 8 caracteres.');
}

const superadmins = () => (process.env.SUPERADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);

// ------------------------------------------------------------------ cadastro

export async function cadastrar({ nome, email, senha, empresa }) {
  if (!nome?.trim()) throw invalido('Informe seu nome.');
  if (!emailValido(email)) throw invalido('E-mail inválido.');
  conferirSenhaForte(senha);
  if (!empresa?.trim()) throw invalido('Informe o nome da empresa ou escritório.');
  const hash = await hashSenha(senha);
  return transacao(async (c) => {
    const existe = await c.query('SELECT 1 FROM usuarios WHERE email = $1', [email]);
    if (existe.rowCount) throw new ErroApp(409, 'Já existe uma conta com este e-mail. Use "Esqueci minha senha".');
    const u = (await c.query(
      'INSERT INTO usuarios (email, nome, senha_hash) VALUES ($1, $2, $3) RETURNING *',
      [email.trim(), nome.trim(), hash])).rows[0];
    const conta = (await c.query(
      `INSERT INTO contas (nome, plano, teste_ate) VALUES ($1, 'teste', now() + make_interval(days => $2)) RETURNING *`,
      [empresa.trim(), config.diasTeste])).rows[0];
    await c.query(`INSERT INTO membros (conta_id, usuario_id, papel) VALUES ($1, $2, 'dono')`, [conta.id, u.id]);
    return { usuario: u, conta };
  }).then(async (r) => {
    await enviarVerificacao(r.usuario).catch(() => {});
    return r;
  });
}

async function enviarVerificacao(u) {
  const { token, hash } = novoToken();
  await q(`INSERT INTO tokens_usuario (usuario_id, tipo, token_hash, expira_em) VALUES ($1, 'verificar_email', $2, now() + interval '7 days')`, [u.id, hash]);
  await enviarEmail({
    para: u.email, assunto: `Confirme seu e-mail — ${config.nomeApp}`, titulo: `Bem-vindo(a), ${u.nome.split(' ')[0]}!`,
    corpo: '<p>Confirme seu e-mail para garantir a recuperação de acesso e receber avisos sobre suas notas.</p>',
    botao: { texto: 'Confirmar e-mail', url: `${config.urlApp}/entrar.html#verificar=${token}` },
  });
}

export async function verificarEmail(token) {
  const t = await um(`UPDATE tokens_usuario SET usado_em = now() WHERE token_hash = $1 AND tipo = 'verificar_email' AND usado_em IS NULL AND expira_em > now() RETURNING usuario_id`, [hashToken(token)]);
  if (!t) throw invalido('Link de confirmação inválido ou expirado.');
  await q('UPDATE usuarios SET email_verificado_em = now() WHERE id = $1', [t.usuario_id]);
  await promoverSuperadmin(t.usuario_id);
}

/** Superadmin só é concedido a e-mails da lista que já foram confirmados (prova de posse). */
async function promoverSuperadmin(usuarioId) {
  const lista = superadmins();
  if (!lista.length) return;
  await q(`UPDATE usuarios SET superadmin = true WHERE id = $1 AND email_verificado_em IS NOT NULL AND lower(email::text) = ANY($2)`, [usuarioId, lista]);
}

// ------------------------------------------------------------------ sessão

export async function autenticar({ email, senha }) {
  const u = await um('SELECT * FROM usuarios WHERE email = $1', [email]);
  // Compara mesmo sem usuário, para não revelar quais e-mails existem pelo tempo de resposta.
  const ok = await conferirSenha(senha || '', u?.senha_hash || 'scrypt$AAAA$AAAA');
  if (!u || !ok) throw new ErroApp(401, 'E-mail ou senha incorretos.');
  await q('UPDATE usuarios SET ultimo_login_em = now() WHERE id = $1', [u.id]);
  await promoverSuperadmin(u.id);
  return u;
}

export async function criarSessao(usuarioId, { ip, userAgent, contaId } = {}) {
  const { token, hash } = novoToken('s_');
  const conta = contaId || (await um('SELECT conta_id FROM membros WHERE usuario_id = $1 ORDER BY criado_em LIMIT 1', [usuarioId]))?.conta_id;
  await q(`INSERT INTO sessoes (usuario_id, conta_id, token_hash, expira_em, ip, user_agent)
           VALUES ($1, $2, $3, now() + make_interval(days => $4), $5, $6)`,
    [usuarioId, conta || null, hash, DIAS_SESSAO, ip || null, String(userAgent || '').slice(0, 300)]);
  return { token, maxAge: DIAS_SESSAO * 86400 };
}

export async function sessaoPorToken(token) {
  if (!token) return null;
  return um(`SELECT s.id AS sessao_id, s.conta_id, s.expira_em, u.id, u.email, u.nome, u.superadmin, u.email_verificado_em
             FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
             WHERE s.token_hash = $1 AND s.expira_em > now()`, [hashToken(token)]);
}

export async function encerrarSessao(token) {
  await q('DELETE FROM sessoes WHERE token_hash = $1', [hashToken(token)]);
}

export async function trocarConta(sessaoId, usuarioId, contaId) {
  const m = await um('SELECT 1 FROM membros WHERE conta_id = $1 AND usuario_id = $2', [contaId, usuarioId]);
  if (!m) throw proibido();
  await q('UPDATE sessoes SET conta_id = $1 WHERE id = $2', [contaId, sessaoId]);
}

export async function chavePorToken(token) {
  const k = await um(`SELECT * FROM chaves_api WHERE token_hash = $1 AND revogada_em IS NULL`, [hashToken(token)]);
  if (k) q('UPDATE chaves_api SET ultimo_uso_em = now() WHERE id = $1', [k.id]).catch(() => {});
  return k;
}

export async function papelNaConta(usuarioId, contaId) {
  return (await um('SELECT papel FROM membros WHERE usuario_id = $1 AND conta_id = $2', [usuarioId, contaId]))?.papel || null;
}

export async function contaPorId(id) {
  return um('SELECT * FROM contas WHERE id = $1', [id]);
}

// ------------------------------------------------------------------ senha

export async function esqueciSenha(email) {
  const u = await um('SELECT * FROM usuarios WHERE email = $1', [email]);
  if (!u) return; // resposta idêntica para não revelar cadastros
  const { token, hash } = novoToken();
  await q(`INSERT INTO tokens_usuario (usuario_id, tipo, token_hash, expira_em) VALUES ($1, 'redefinir_senha', $2, now() + interval '1 hour')`, [u.id, hash]);
  await enviarEmail({
    para: u.email, assunto: `Redefinição de senha — ${config.nomeApp}`, titulo: 'Redefinir sua senha',
    corpo: '<p>Recebemos um pedido para redefinir sua senha. O link vale por 1 hora. Se não foi você, ignore este e-mail.</p>',
    botao: { texto: 'Criar nova senha', url: `${config.urlApp}/entrar.html#redefinir=${token}` },
  });
}

export async function redefinirSenha(token, senha) {
  conferirSenhaForte(senha);
  const hash = await hashSenha(senha);
  return transacao(async (c) => {
    const t = (await c.query(`UPDATE tokens_usuario SET usado_em = now() WHERE token_hash = $1 AND tipo = 'redefinir_senha'
      AND usado_em IS NULL AND expira_em > now() RETURNING usuario_id`, [hashToken(token)])).rows[0];
    if (!t) throw invalido('Link de redefinição inválido ou expirado.');
    await c.query('UPDATE usuarios SET senha_hash = $1, email_verificado_em = coalesce(email_verificado_em, now()) WHERE id = $2', [hash, t.usuario_id]);
    await c.query('DELETE FROM sessoes WHERE usuario_id = $1', [t.usuario_id]); // derruba sessões antigas
    return t.usuario_id;
  }).then(async (id) => { await promoverSuperadmin(id); return id; });
}

export async function trocarSenha(usuarioId, atual, nova) {
  const u = await um('SELECT senha_hash FROM usuarios WHERE id = $1', [usuarioId]);
  if (!(await conferirSenha(atual, u.senha_hash))) throw invalido('Senha atual incorreta.');
  conferirSenhaForte(nova);
  await q('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [await hashSenha(nova), usuarioId]);
}

// ------------------------------------------------------------------ "eu"

export async function resumoUsuario(usuario, contaId) {
  const contas = await varios(`SELECT c.id, c.nome, c.plano, c.status, m.papel FROM membros m JOIN contas c ON c.id = m.conta_id
                               WHERE m.usuario_id = $1 ORDER BY c.nome`, [usuario.id]);
  const ativa = contas.find((c) => c.id === contaId) || contas[0] || null;
  return {
    usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, superadmin: usuario.superadmin, emailVerificado: !!usuario.email_verificado_em },
    contas,
    conta: ativa ? await situacaoConta(ativa.id) : null,
    papel: ativa?.papel || null,
  };
}

/** Plano, uso do mês e bloqueios da conta. */
export async function situacaoConta(contaId) {
  const c = await contaPorId(contaId);
  if (!c) throw naoEncontrado('Conta');
  const p = plano(c.plano);
  const uso = await um(`SELECT
      (SELECT count(*)::int FROM notas WHERE conta_id = $1 AND ambiente = 'producao' AND status IN ('autorizada', 'cancelada', 'processando', 'enviando')
         AND criado_em >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') AS notas_mes,
      (SELECT count(*)::int FROM prestadores WHERE conta_id = $1 AND ativo) AS prestadores,
      (SELECT count(*)::int FROM membros WHERE conta_id = $1) AS usuarios`, [contaId]);
  const testeExpirado = c.plano === 'teste' && c.teste_ate && new Date(c.teste_ate) < new Date();
  return {
    id: c.id, nome: c.nome, documento: c.documento, status: c.status, plano: c.plano, nomePlano: p.nome,
    testeAte: c.teste_ate, testeExpirado, limites: p,
    assinatura: { status: c.assinatura_status, planoContratado: c.plano_contratado, pagoAte: c.pago_ate, motivoSuspensao: c.motivo_suspensao },
    uso: { notasMes: uso.notas_mes, prestadores: uso.prestadores, usuarios: uso.usuarios },
  };
}

export async function atualizarConta(contaId, { nome, documento }) {
  if (!nome?.trim()) throw invalido('Informe o nome da conta.');
  await q('UPDATE contas SET nome = $1, documento = $2, atualizado_em = now() WHERE id = $3', [nome.trim(), documento || null, contaId]);
}

// ------------------------------------------------------------------ equipe

export async function listarEquipe(contaId) {
  const membros = await varios(`SELECT u.id, u.nome, u.email, m.papel, m.criado_em, u.ultimo_login_em FROM membros m
     JOIN usuarios u ON u.id = m.usuario_id WHERE m.conta_id = $1 ORDER BY m.criado_em`, [contaId]);
  const convites = await varios(`SELECT id, email, papel, expira_em, criado_em FROM convites
     WHERE conta_id = $1 AND aceito_em IS NULL AND expira_em > now() ORDER BY criado_em DESC`, [contaId]);
  return { membros, convites };
}

export async function convidar(contaId, convidadoPor, { email, papel }) {
  if (!emailValido(email)) throw invalido('E-mail inválido.');
  if (!['admin', 'emissor', 'leitura'].includes(papel)) throw invalido('Papel inválido.');
  const sit = await situacaoConta(contaId);
  const pendentes = (await um('SELECT count(*)::int AS n FROM convites WHERE conta_id = $1 AND aceito_em IS NULL AND expira_em > now()', [contaId])).n;
  if (sit.uso.usuarios + pendentes >= sit.limites.usuarios)
    throw new ErroApp(402, `Seu plano permite ${sit.limites.usuarios} usuário(s). Faça upgrade para convidar mais pessoas.`);
  const ja = await um('SELECT 1 FROM membros m JOIN usuarios u ON u.id = m.usuario_id WHERE m.conta_id = $1 AND u.email = $2', [contaId, email]);
  if (ja) throw new ErroApp(409, 'Esta pessoa já faz parte da equipe.');
  const { token, hash } = novoToken();
  await q(`INSERT INTO convites (conta_id, email, papel, token_hash, convidado_por, expira_em) VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')`,
    [contaId, email, papel, hash, convidadoPor]);
  const conta = await contaPorId(contaId);
  await enviarEmail({
    para: email, assunto: `Convite para ${conta.nome} — ${config.nomeApp}`, titulo: 'Você foi convidado(a)',
    corpo: `<p>Você foi convidado(a) para emitir notas fiscais de serviço da equipe <b>${conta.nome.replace(/</g, '&lt;')}</b>.</p>`,
    botao: { texto: 'Aceitar convite', url: `${config.urlApp}/entrar.html#convite=${token}` },
  });
  return { token };
}

export async function cancelarConvite(contaId, id) {
  await q('DELETE FROM convites WHERE id = $1 AND conta_id = $2 AND aceito_em IS NULL', [id, contaId]);
}

export async function infoConvite(token) {
  const c = await um(`SELECT cv.email, cv.papel, c.nome AS conta, (SELECT 1 FROM usuarios u WHERE u.email = cv.email) AS tem_usuario
    FROM convites cv JOIN contas c ON c.id = cv.conta_id WHERE cv.token_hash = $1 AND cv.aceito_em IS NULL AND cv.expira_em > now()`, [hashToken(token)]);
  if (!c) throw invalido('Convite inválido ou expirado.');
  return { email: c.email, papel: c.papel, conta: c.conta, temUsuario: !!c.tem_usuario };
}

/** Aceita o convite. Se a pessoa ainda não tem usuário, cria com nome/senha. */
export async function aceitarConvite(token, { nome, senha, usuarioLogado } = {}) {
  const hashS = senha ? await hashSenha(senha) : null;
  return transacao(async (c) => {
    const cv = (await c.query(`SELECT * FROM convites WHERE token_hash = $1 AND aceito_em IS NULL AND expira_em > now() FOR UPDATE`, [hashToken(token)])).rows[0];
    if (!cv) throw invalido('Convite inválido ou expirado.');
    let u = (await c.query('SELECT * FROM usuarios WHERE email = $1', [cv.email])).rows[0];
    if (u && usuarioLogado && usuarioLogado !== u.id) throw proibido('Este convite foi enviado para outro e-mail.');
    if (u && !usuarioLogado) throw new ErroApp(401, 'Entre com sua conta para aceitar o convite.');
    if (!u) {
      if (!nome?.trim()) throw invalido('Informe seu nome.');
      conferirSenhaForte(senha);
      u = (await c.query(`INSERT INTO usuarios (email, nome, senha_hash, email_verificado_em) VALUES ($1, $2, $3, now()) RETURNING *`,
        [cv.email, nome.trim(), hashS])).rows[0];
    }
    await c.query(`INSERT INTO membros (conta_id, usuario_id, papel) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [cv.conta_id, u.id, cv.papel]);
    await c.query('UPDATE convites SET aceito_em = now() WHERE id = $1', [cv.id]);
    return { usuario: u, contaId: cv.conta_id };
  });
}

export async function alterarPapel(contaId, usuarioId, papel, quem) {
  if (!PAPEIS.includes(papel)) throw invalido('Papel inválido.');
  if (papel === 'dono' && quem.papel !== 'dono') throw proibido('Só o dono pode transferir a propriedade.');
  await transacao(async (c) => {
    const alvo = (await c.query('SELECT papel FROM membros WHERE conta_id = $1 AND usuario_id = $2 FOR UPDATE', [contaId, usuarioId])).rows[0];
    if (!alvo) throw naoEncontrado('Membro');
    if (alvo.papel === 'dono' && quem.papel !== 'dono') throw proibido();
    await c.query('UPDATE membros SET papel = $1 WHERE conta_id = $2 AND usuario_id = $3', [papel, contaId, usuarioId]);
    if (papel === 'dono') await c.query(`UPDATE membros SET papel = 'admin' WHERE conta_id = $1 AND usuario_id = $2`, [contaId, quem.usuarioId]);
    const donos = (await c.query(`SELECT count(*)::int AS n FROM membros WHERE conta_id = $1 AND papel = 'dono'`, [contaId])).rows[0].n;
    if (donos !== 1) throw invalido('A conta precisa ter exatamente um dono.');
  });
}

export async function removerMembro(contaId, usuarioId, quem) {
  const alvo = await um('SELECT papel FROM membros WHERE conta_id = $1 AND usuario_id = $2', [contaId, usuarioId]);
  if (!alvo) throw naoEncontrado('Membro');
  if (alvo.papel === 'dono') throw invalido('Transfira a propriedade antes de remover o dono.');
  if (alvo.papel === 'admin' && quem.papel !== 'dono') throw proibido();
  await q('DELETE FROM membros WHERE conta_id = $1 AND usuario_id = $2', [contaId, usuarioId]);
  await q('UPDATE sessoes SET conta_id = NULL WHERE usuario_id = $1 AND conta_id = $2', [usuarioId, contaId]);
}

// ------------------------------------------------------------------ chaves de API

export async function listarChaves(contaId) {
  return varios(`SELECT id, nome, prefixo, papel, ultimo_uso_em, revogada_em, criado_em FROM chaves_api WHERE conta_id = $1 ORDER BY criado_em DESC`, [contaId]);
}

export async function criarChave(contaId, usuarioId, { nome, papel = 'emissor' }) {
  const sit = await situacaoConta(contaId);
  if (!sit.limites.api) throw new ErroApp(402, 'A API está disponível a partir do plano Profissional.');
  if (!nome?.trim()) throw invalido('Dê um nome para a chave (ex.: "ERP").');
  if (!['admin', 'emissor', 'leitura'].includes(papel)) throw invalido('Papel inválido.');
  const { token, hash } = novoToken('nfk_', 24);
  const k = await um(`INSERT INTO chaves_api (conta_id, nome, prefixo, token_hash, papel, criado_por) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, nome, prefixo, papel, criado_em`, [contaId, nome.trim(), token.slice(0, 12), hash, papel, usuarioId]);
  return { ...k, token }; // o token completo só é mostrado uma vez
}

export async function revogarChave(contaId, id) {
  await q('UPDATE chaves_api SET revogada_em = now() WHERE id = $1 AND conta_id = $2 AND revogada_em IS NULL', [id, contaId]);
}
