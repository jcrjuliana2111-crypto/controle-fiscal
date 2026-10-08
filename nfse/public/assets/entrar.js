const API = '/api/v1';

async function chamar(caminho, corpo, metodo = 'POST') {
  const r = await fetch(API + caminho, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(dados.erro || 'Não foi possível concluir. Tente novamente.'), { status: r.status });
  return dados;
}

const params = () => {
  const h = location.hash.slice(1);
  const [modo, token] = h.split('=');
  return { modo: modo || 'entrar', token };
};

function mostrar(modo) {
  document.querySelectorAll('[data-modo]').forEach((f) => f.classList.toggle('ativo', f.dataset.modo === modo));
  const f = document.querySelector(`[data-modo="${modo}"]`);
  f?.querySelector('.msg') && (f.querySelector('.msg').textContent = '');
  f?.querySelector('input:not([type=hidden])')?.focus();
  document.title = `${f?.querySelector('h1')?.textContent || 'Entrar'} — ${document.title.split(' — ').pop()}`;
}

async function iniciar() {
  const { modo, token } = params();
  // Já logado? Vai direto para o sistema (exceto fluxos com token).
  if (['entrar', 'cadastro'].includes(modo)) {
    const r = await fetch(API + '/auth/eu');
    if (r.ok) return location.replace('/app.html');
  }
  mostrar(modo);
  if (modo === 'convite') {
    const f = document.querySelector('[data-modo=convite]');
    try {
      const c = await chamar(`/auth/convite/${token}`, null, 'GET');
      f.querySelector('[data-convite-texto]').textContent = `Você foi convidado(a) para a equipe ${c.conta} com o e-mail ${c.email}.`;
      if (c.temUsuario) {
        f.querySelector('[data-convite-novo]').classList.add('oculto');
        const eu = await fetch(API + '/auth/eu');
        if (!eu.ok) {
          f.querySelector('.msg').textContent = 'Este e-mail já tem cadastro. Entre com sua senha e abra o link do convite novamente.';
          f.querySelector('button').classList.add('oculto');
        }
      }
    } catch (e) {
      f.querySelector('.msg').textContent = e.message;
      f.querySelector('button').classList.add('oculto');
    }
  }
  if (modo === 'verificar') {
    const msg = document.querySelector('[data-modo=verificar] .msg');
    try { await chamar('/auth/verificar', { token }); msg.className = 'msg ok'; msg.textContent = 'E-mail confirmado.'; }
    catch (e) { msg.textContent = e.message; }
  }
}

const ACOES = {
  entrar: async (d) => { await chamar('/auth/entrar', d); location.assign('/app.html'); },
  cadastro: async (d) => { await chamar('/auth/cadastro', d); location.assign('/app.html#boas-vindas'); },
  esqueci: async (d, f) => {
    const r = await chamar('/auth/esqueci', d);
    const m = f.querySelector('.msg'); m.className = 'msg ok'; m.textContent = r.mensagem;
  },
  redefinir: async (d) => { await chamar('/auth/redefinir', { token: params().token, senha: d.senha }); location.assign('/app.html'); },
  convite: async (d) => { await chamar(`/auth/convite/${params().token}/aceitar`, d); location.assign('/app.html'); },
};

document.addEventListener('submit', async (ev) => {
  const f = ev.target.closest('form[data-modo]');
  if (!f) return;
  ev.preventDefault();
  const botao = f.querySelector('button[type=submit]');
  const msg = f.querySelector('.msg');
  msg.className = 'msg'; msg.textContent = '';
  botao.disabled = true;
  try {
    await ACOES[f.dataset.modo](Object.fromEntries(new FormData(f)), f);
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    botao.disabled = false;
  }
});

window.addEventListener('hashchange', iniciar);
iniciar();
