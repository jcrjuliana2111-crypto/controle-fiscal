import { q, varios } from '../db/pool.js';

/** Registra uma ação relevante (quem, o quê, quando, de onde). Nunca derruba a requisição. */
export function auditar(ctx, acao, alvo, detalhes) {
  return q(`INSERT INTO auditoria (conta_id, usuario_id, chave_api_id, acao, alvo, detalhes, ip) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ctx.contaId || null, ctx.usuarioId || null, ctx.chaveApiId || null, acao, alvo || null, detalhes ? JSON.stringify(detalhes) : null, ctx.ip || null])
    .catch((e) => console.error('[auditoria]', e.message));
}

export function listarAuditoria(contaId, { limite = 100 } = {}) {
  return varios(`SELECT a.acao, a.alvo, a.detalhes, a.ip, a.criado_em, u.nome AS usuario, k.nome AS chave_api
    FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id LEFT JOIN chaves_api k ON k.id = a.chave_api_id
    WHERE a.conta_id = $1 ORDER BY a.criado_em DESC LIMIT $2`, [contaId, Math.min(Number(limite) || 100, 500)]);
}
