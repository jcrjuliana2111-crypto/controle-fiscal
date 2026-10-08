export class ErroApp extends Error {
  constructor(status, mensagem, extra = {}) {
    super(mensagem);
    this.status = status;
    Object.assign(this, extra);
  }
}

export const naoEncontrado = (o = 'Registro') => new ErroApp(404, `${o} não encontrado.`);
export const proibido = (m = 'Você não tem permissão para esta ação.') => new ErroApp(403, m);
export const invalido = (m, erros) => new ErroApp(422, m, { erros });
