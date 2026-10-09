// Planos comerciais. fiscalMes = requisições ao Integra Contador (SERPRO) incluídas por mês.
// Preços são sugestão — ajuste à sua estratégia.
// Limite de notas conta apenas NFS-e autorizadas em PRODUÇÃO no mês corrente;
// homologação é livre (respeitando o limite de requisições).

export const PLANOS = {
  teste: { nome: 'Teste grátis', preco: 0, notasMes: 30, prestadores: 2, usuarios: 2, api: true, webhooks: true, fiscalMes: 30 },
  essencial: { nome: 'Essencial', preco: 59, notasMes: 100, prestadores: 1, usuarios: 2, api: false, webhooks: false, fiscalMes: 50 },
  profissional: { nome: 'Profissional', preco: 149, notasMes: 500, prestadores: 5, usuarios: 5, api: true, webhooks: true, fiscalMes: 500 },
  escritorio: { nome: 'Escritório contábil', preco: 399, notasMes: 3000, prestadores: 60, usuarios: 20, api: true, webhooks: true, fiscalMes: 3000 },
};

export function plano(id) {
  return PLANOS[id] || PLANOS.teste;
}

export function planosPublicos() {
  return Object.entries(PLANOS).map(([id, p]) => ({ id, ...p }));
}

// Papéis e o que cada um pode fazer.
const PERMISSOES = {
  leitura: ['ver'],
  emissor: ['ver', 'emitir', 'cancelar'],
  admin: ['ver', 'emitir', 'cancelar', 'prestadores', 'municipios', 'equipe', 'integracoes'],
  dono: ['ver', 'emitir', 'cancelar', 'prestadores', 'municipios', 'equipe', 'integracoes', 'conta'],
};

export function pode(papel, permissao) {
  return (PERMISSOES[papel] || []).includes(permissao);
}

export const PAPEIS = Object.keys(PERMISSOES);
