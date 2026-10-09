const params = new URLSearchParams(location.search);
const slug = params.get('c');
const $ = (s) => document.querySelector(s);
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DESCRICAO = {
  'e-CNPJ A1': 'Empresa, arquivo no computador, validade de 1 ano',
  'e-CPF A1': 'Pessoa física, arquivo no computador, validade de 1 ano',
  'e-CNPJ A3': 'Empresa, em token ou cartão, até 3 anos',
  'e-CPF A3': 'Pessoa física, em token ou cartão, até 3 anos',
  'NF-e A1': 'Específico para emissão de notas fiscais',
};
const brl = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

async function iniciar() {
  let pagina;
  try {
    const r = await fetch(`/api/v1/publico/certificado/${encodeURIComponent(slug || '')}`);
    if (!r.ok) throw new Error();
    pagina = await r.json();
  } catch {
    $('#form-pedido').classList.add('oculto');
    $('[data-indisponivel]').classList.remove('oculto');
    return;
  }
  document.title = `Certificado digital — ${pagina.nome}`;
  $('[data-vendedor]').textContent = pagina.nome;
  if (pagina.mensagem) $('[data-mensagem]').textContent = pagina.mensagem;
  const renovacao = params.get('renovacao') === '1';
  if (renovacao) $('[data-titulo]').textContent = 'Renove seu certificado digital';
  const tipoInicial = params.get('tipo') && pagina.tipos.includes(params.get('tipo')) ? params.get('tipo') : pagina.tipos[0];
  $('[data-tipos]').innerHTML = pagina.tipos.map((t) => `<label class="tipo"><input type="radio" name="tipo" value="${h(t)}"${t === tipoInicial ? ' checked' : ''}>
    <strong>${h(t)}${pagina.precos?.[t] ? ` · ${brl(pagina.precos[t])}` : ''}</strong><span>${h(DESCRICAO[t] || '')}</span></label>`).join('');
  const sincronizar = () => {
    const pj = /^(e-CNPJ|NF-e)/.test(document.querySelector('input[name=tipo]:checked')?.value || '');
    $('[data-pj]').classList.toggle('oculto', !pj);
    $('[data-legenda-titular]').textContent = pj ? 'Responsável legal' : 'Titular';
  };
  document.querySelectorAll('input[name=tipo]').forEach((i) => i.addEventListener('change', sincronizar));
  sincronizar();
  $('#form-pedido').dataset.renovacao = renovacao ? '1' : '';
}

$('[data-cep]').addEventListener('blur', async (e) => {
  const cep = e.target.value.replace(/\D/g, '');
  if (cep.length !== 8) return;
  try {
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`).then((x) => x.json());
    if (!r.erro) $('[data-cidade]').value = `${r.localidade}/${r.uf}`;
  } catch { /* preenchimento manual */ }
});

$('#form-pedido').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const d = Object.fromEntries(new FormData(f));
  d.aceite = f.aceite.checked;
  d.renovacao = f.dataset.renovacao === '1';
  const [cidade, uf] = String(d.cidadeUf || '').split('/');
  Object.assign(d, { cidade: cidade?.trim(), uf: uf?.trim() });
  const botao = f.querySelector('button[type=submit]');
  const msg = f.querySelector('.msg');
  msg.textContent = ''; botao.disabled = true; botao.textContent = 'Enviando…';
  try {
    const r = await fetch(`/api/v1/publico/certificado/${encodeURIComponent(slug)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d),
    });
    const res = await r.json();
    if (!r.ok) throw new Error(res.erro || 'Não foi possível enviar. Tente novamente.');
    f.classList.add('oculto');
    $('[data-sucesso]').classList.remove('oculto');
    $('[data-sucesso-texto]').textContent = `Seu pedido nº ${res.numero} foi recebido. ${res.linkCompra ? 'Para agilizar, conclua a compra no link abaixo.' : 'Em breve entraremos em contato.'}`;
    $('[data-sucesso-acoes]').innerHTML =
      (res.linkCompra ? `<a class="btn btn-primario" href="${h(res.linkCompra)}" target="_blank" rel="noopener">Concluir a compra</a>` : '') +
      (res.whatsapp ? `<a class="btn btn-secundario" href="https://wa.me/${h(res.whatsapp)}?text=${encodeURIComponent(`Olá! Acabei de fazer o pedido de certificado nº ${res.numero}.`)}" target="_blank" rel="noopener">Falar no WhatsApp</a>` : '');
    window.scrollTo(0, 0);
  } catch (x) {
    msg.textContent = x.message;
  } finally {
    botao.disabled = false; botao.textContent = 'Enviar pedido';
  }
});

iniciar();
