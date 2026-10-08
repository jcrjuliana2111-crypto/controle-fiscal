// Aplicativo do emissor: roteamento por hash, telas e ações.
// Sem scripts inline: ações usam data-acao e delegação de eventos (compatível com a CSP).

const API = '/api/v1';
const estado = { eu: null, info: null, prestadores: [], notasFiltro: { pagina: 1 } };

// ------------------------------------------------------------------ utilidades
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const data = (s) => (s ? new Date(String(s).length === 10 ? s + 'T12:00:00' : s).toLocaleDateString('pt-BR') : '');
const dataHora = (s) => (s ? new Date(s).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');
const fmtDoc = (d = '') => d.length === 14 ? d.replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, '$1.$2.$3/$4-$5')
  : d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : d;
const hojeBR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

async function api(caminho, { metodo = 'GET', corpo, headers = {} } = {}) {
  const r = await fetch(API + caminho, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...headers },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  if (r.status === 401 && !caminho.startsWith('/auth/entrar')) { location.assign('/entrar.html'); throw new Error('Sessão expirada.'); }
  if (r.status === 204) return null;
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(dados.erro || `Erro ${r.status}`), { status: r.status, erros: dados.erros });
  return dados;
}

let toastTimer;
function toast(msg, tipo = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `aviso-flutuante visivel ${tipo}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'aviso-flutuante'), 4500);
}

const PERMISSOES = {
  leitura: ['ver'],
  emissor: ['ver', 'emitir', 'cancelar'],
  admin: ['ver', 'emitir', 'cancelar', 'prestadores', 'municipios', 'equipe', 'integracoes'],
  dono: ['ver', 'emitir', 'cancelar', 'prestadores', 'municipios', 'equipe', 'integracoes', 'conta'],
};
const pode = (p) => (PERMISSOES[estado.eu?.papel] || []).includes(p);
const NOME_PAPEL = { dono: 'Dono', admin: 'Administrador', emissor: 'Emissor', leitura: 'Somente leitura' };

const SITUACAO = {
  autorizada: ['selo-ok', 'Autorizada'], rejeitada: ['selo-erro', 'Rejeitada'], processando: ['selo-alerta', 'Processando'],
  enviando: ['selo-alerta', 'Enviando'], cancelada: ['selo-neutro', 'Cancelada'], validada: ['selo-info', 'Validada (teste)'],
};
const selo = (s) => { const [c, t] = SITUACAO[s] || ['selo-neutro', s]; return `<span class="selo ${c}">${h(t)}</span>`; };
const NOME_PADRAO = { nacional: 'Portal Nacional', abrasf: 'Prefeitura (ABRASF)', 'sao-paulo': 'Prefeitura de São Paulo' };
const seloAmbiente = (a) => (a === 'producao' ? '<span class="selo selo-alerta">Produção</span>' : '<span class="selo selo-neutro">Homologação</span>');

function mensagensHtml(msgs, tipo) {
  return (msgs || []).map((m) => `<div class="mensagem ${tipo}">${m.codigo ? `<b>${h(m.codigo)}</b>` : ''}${h(m.mensagem)}${m.correcao ? `<small>${h(m.correcao)}</small>` : ''}</div>`).join('');
}

function definirValor(obj, caminho, valor) {
  const partes = caminho.split('.');
  let o = obj;
  partes.slice(0, -1).forEach((p) => (o = o[p] ??= {}));
  o[partes.at(-1)] = valor;
}

/** Lê um formulário com nomes "a.b.c" para um objeto aninhado. */
function lerForm(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.type === 'file' || el.closest('.oculto')) continue;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'number') v = el.value === '' ? undefined : Number(el.value);
    else v = el.value.trim();
    if (v === undefined || v === '') continue;
    definirValor(out, el.name, v);
  }
  return out;
}

function preencherForm(form, dados) {
  for (const el of form.elements) {
    if (!el.name || el.type === 'file') continue;
    const v = el.name.split('.').reduce((o, k) => o?.[k], dados);
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
  }
}

function confirmar(msg) { return window.confirm(msg); }

// ------------------------------------------------------------------ sessão e layout
async function carregarSessao() {
  [estado.eu, estado.info] = await Promise.all([api('/auth/eu'), api('/info')]);
  const { usuario, contas, conta, papel } = estado.eu;
  $('#usuario-nome').textContent = usuario.nome;
  $('#usuario-papel').textContent = `${NOME_PAPEL[papel] || ''}${conta ? ' em ' + conta.nome : ''}`;
  const sel = $('#seletor-conta');
  sel.innerHTML = contas.map((c) => `<option value="${c.id}"${c.id === conta?.id ? ' selected' : ''}>${h(c.nome)}</option>`).join('');
  sel.closest('label').classList.toggle('oculto', contas.length < 2);
  $$('#menu [data-perm]').forEach((a) => a.classList.toggle('oculto', !pode(a.dataset.perm)));
  $('#menu [data-superadmin]').classList.toggle('oculto', !usuario.superadmin);
  renderAvisos();
}

function renderAvisos() {
  const { usuario, conta } = estado.eu;
  const avisos = [];
  if (conta?.status === 'suspensa') avisos.push(['erro', 'Esta conta está suspensa. A emissão de notas está bloqueada até a regularização.', '#/conta', 'Ver plano']);
  else if (conta?.plano === 'teste') {
    const dias = Math.ceil((new Date(conta.testeAte) - Date.now()) / 864e5);
    if (conta.testeExpirado) avisos.push(['erro', 'Seu período de teste terminou. A homologação continua liberada; para emitir em produção, assine um plano.', '#/conta', 'Ver planos']);
    else avisos.push(['info', `Teste grátis: ${dias} dia${dias === 1 ? '' : 's'} restante${dias === 1 ? '' : 's'}.`, '#/conta', 'Conhecer os planos']);
  }
  if (!usuario.emailVerificado) avisos.push(['alerta', `Confirme seu e-mail (${usuario.email}) pelo link que enviamos.`]);
  $('#avisos').innerHTML = avisos.map(([t, msg, link, txt]) => `<div class="aviso aviso-${t}"><span>${h(msg)}</span>${link ? `<a href="${link}">${h(txt)}</a>` : ''}</div>`).join('');
}

async function carregarPrestadores() {
  estado.prestadores = await api('/prestadores');
  return estado.prestadores;
}

// ------------------------------------------------------------------ roteamento
const ROTAS = {
  painel: telaPainel, emitir: telaEmitir, notas: telaNotas, empresas: telaEmpresas, municipios: telaMunicipios,
  equipe: telaEquipe, integracoes: telaIntegracoes, conta: telaConta, admin: telaAdmin,
};

async function navegar() {
  const [rota, param] = location.hash.replace(/^#\/?/, '').split('/');
  const nome = ROTAS[rota] ? rota : 'painel';
  $$('#menu a').forEach((a) => (a.dataset.rota === nome ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  $('#lateral').classList.remove('aberta');
  const alvo = $('#conteudo');
  alvo.innerHTML = '<p class="carregando">Carregando…</p>';
  try {
    if (nome === 'notas' && param) await telaNota(alvo, param);
    else await ROTAS[nome](alvo, param);
  } catch (e) {
    alvo.innerHTML = `<div class="vazio"><strong>Não foi possível abrir esta tela</strong>${h(e.message)}</div>`;
  }
  alvo.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ painel
async function telaPainel(alvo) {
  const [painel, conta, prestadores, ultimas] = await Promise.all([
    api('/painel'), api('/conta'), carregarPrestadores(), api('/notas?porPagina=6'),
  ]);
  const temCert = prestadores.some((p) => p.certificado);
  const novato = !prestadores.length || !temCert || !ultimas.total;
  const m = painel.mes;
  const max = Math.max(1, ...painel.serie.map((s) => s.valor));
  const meses = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    const chave = d.toISOString().slice(0, 7);
    meses.push({ chave, rotulo: d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', ''), ...(painel.serie.find((s) => s.mes === chave) || { valor: 0, notas: 0 }) });
  }
  const medidor = (rotulo, uso, lim) => `<div class="medidor"><div class="medidor-topo"><span>${rotulo}</span><span>${uso.toLocaleString('pt-BR')} de ${lim.toLocaleString('pt-BR')}</span></div>
    <div class="medidor-barra"><i style="width:${Math.min(100, (uso / lim) * 100)}%" class="${uso >= lim ? 'cheio' : ''}"></i></div></div>`;

  alvo.innerHTML = `
    <div class="cabecalho-pagina"><div><h1>Olá, ${h(estado.eu.usuario.nome.split(' ')[0])}</h1><p>Resumo de ${h(new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }))}, notas em produção.</p></div>
      ${pode('emitir') ? '<a class="btn btn-primario" href="#/emitir">Emitir nota</a>' : ''}</div>
    ${novato ? `<section class="bloco"><h2>Primeiros passos</h2><ol class="lista-passos">
      <li class="${prestadores.length ? 'feito' : ''}"><div><strong>Cadastre a empresa emitente</strong><p>CNPJ, inscrição municipal e código IBGE do município. <a href="#/empresas">Abrir empresas</a></p></div></li>
      <li class="${temCert ? 'feito' : ''}"><div><strong>Instale o certificado A1</strong><p>No cadastro da empresa, envie o arquivo .pfx e a senha.</p></div></li>
      <li class="${ultimas.total ? 'feito' : ''}"><div><strong>Emita uma nota de teste</strong><p>Em homologação a nota não tem valor fiscal e não conta no seu plano. <a href="#/emitir">Emitir agora</a></p></div></li>
    </ol></section>` : ''}
    <dl class="indicadores">
      <div class="indicador"><dt>Notas autorizadas</dt><dd>${m.autorizadas}</dd></div>
      <div class="indicador"><dt>Faturado</dt><dd>${brl(m.faturado)}</dd></div>
      <div class="indicador"><dt>ISS do mês</dt><dd>${brl(m.iss)}${m.iss_retido ? `<small> ${brl(m.iss_retido)} retido</small>` : ''}</dd></div>
      <div class="indicador"><dt>Precisam de atenção</dt><dd>${m.rejeitadas + m.pendentes}${m.pendentes ? `<small> ${m.pendentes} aguardando</small>` : ''}</dd></div>
    </dl>
    <div class="duas-colunas">
      <section class="bloco"><h2>Faturamento nos últimos 6 meses</h2>
        ${painel.serie.length ? `<div class="grafico" role="img" aria-label="Faturamento mensal">${meses.map((s) => `<div title="${s.notas} notas"><b>${s.valor ? brl(s.valor).replace(/,\d+$/, '') : ''}</b><i style="height:${(s.valor / max) * 100}%"></i>${h(s.rotulo)}</div>`).join('')}</div>`
          : '<p class="vazio">O faturamento aparece aqui quando você emitir notas em produção. Notas de teste (homologação) não entram no resumo.</p>'}
      </section>
      <section class="bloco"><h2>Plano ${h(conta.nomePlano)}</h2>
        ${medidor('Notas em produção no mês', conta.uso.notasMes, conta.limites.notasMes)}
        ${medidor('Empresas emitentes', conta.uso.prestadores, conta.limites.prestadores)}
        ${medidor('Usuários', conta.uso.usuarios, conta.limites.usuarios)}
        ${painel.certificadosVencendo.length ? `<div class="mensagem alerta"><b>Certificados vencendo</b>${painel.certificadosVencendo.map((c) => `${h(c.razao_social)}: ${data(c.valido_ate)}`).join('<br>')}</div>` : ''}
      </section>
    </div>
    <div class="secao-titulo"><h2>Últimas notas</h2><a href="#/notas">Ver todas</a></div>
    ${tabelaNotas(ultimas.itens)}`;
}

function tabelaNotas(itens) {
  if (!itens.length) return `<div class="tabela-wrap"><div class="vazio"><strong>Nenhuma nota por aqui</strong>As notas emitidas aparecem nesta lista.${pode('emitir') ? '<br><a class="btn btn-primario" href="#/emitir">Emitir nota</a>' : ''}</div></div>`;
  return `<div class="tabela-wrap"><table class="tabela"><thead><tr><th>Situação</th><th>Número</th><th>Tomador</th><th>Empresa</th><th>Competência</th><th class="num">Valor</th><th class="num">ISS</th></tr></thead><tbody>
    ${itens.map((n) => `<tr class="clicavel" data-acao="abrir-nota" data-id="${n.id}" tabindex="0">
      <td>${selo(n.status)} ${n.ambiente !== 'producao' ? '<span class="selo selo-neutro">Teste</span>' : ''}</td>
      <td>${h(n.numero || '—')}<span class="sub">RPS ${h(n.serie)}/${h(n.numeroRps)}</span></td>
      <td>${h(n.tomador?.nome || 'Não identificado')}<span class="sub">${h(fmtDoc(n.tomador?.documento || ''))}</span></td>
      <td>${h(n.prestadorNome)}<span class="sub">${h(NOME_PADRAO[n.provedor] || n.provedor)}</span></td>
      <td>${data(n.competencia)}</td>
      <td class="num">${brl(n.calculo?.valorServico)}</td><td class="num">${brl(n.calculo?.valorIss)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ------------------------------------------------------------------ emitir
async function telaEmitir(alvo) {
  if (!pode('emitir')) { alvo.innerHTML = '<div class="vazio"><strong>Sem permissão para emitir</strong>Peça a um administrador da conta.</div>'; return; }
  const prestadores = await carregarPrestadores();
  if (!prestadores.length) {
    alvo.innerHTML = `<div class="cabecalho-pagina"><div><h1>Emitir nota</h1></div></div><div class="tabela-wrap"><div class="vazio"><strong>Cadastre uma empresa emitente primeiro</strong>Você precisa do CNPJ, da inscrição municipal e do certificado A1.${pode('prestadores') ? '<br><button class="btn btn-primario" data-acao="nova-empresa">Cadastrar empresa</button>' : ''}</div></div>`;
    return;
  }
  alvo.innerHTML = '';
  alvo.appendChild($('#tpl-emitir').content.cloneNode(true));
  const f = $('#form-emitir');
  f.prestadorId.innerHTML = prestadores.map((p) => `<option value="${p.id}">${h(p.razaoSocial)} (${h(fmtDoc(p.documento))})</option>`).join('');
  const ultimo = localStorage.getItem('emissor.ultimoPrestador');
  if (prestadores.some((p) => p.id === ultimo)) f.prestadorId.value = ultimo;
  f.competencia.value = hojeBR();

  f.prestadorId.addEventListener('change', aoTrocarPrestador);
  f['tomador.tipo'].addEventListener('change', aoTrocarTipoTomador);
  f.addEventListener('input', (e) => {
    if (e.target.matches('[data-calc]')) recalcular();
    if (e.target.matches('[data-item-lc]')) sugerirCodigoNacional();
    if (e.target.name === 'servico.codigoTributacaoNacional') e.target.dataset.manual = '1';
  });
  f.addEventListener('change', (e) => { if (e.target.matches('[data-calc]')) recalcular(); });
  $('[data-cep]', f).addEventListener('blur', buscarCep);
  f.addEventListener('submit', (e) => { e.preventDefault(); emitirNota(); });
  aoTrocarTipoTomador();
  await aoTrocarPrestador();
}

async function aoTrocarPrestador() {
  const f = $('#form-emitir');
  const p = estado.prestadores.find((x) => x.id === f.prestadorId.value);
  if (!p) return;
  localStorage.setItem('emissor.ultimoPrestador', p.id);
  if (p.aliquotaPadrao && !f['valores.aliquotaIss'].value) f['valores.aliquotaIss'].value = p.aliquotaPadrao;
  if (p.itemListaPadrao && !f['servico.itemListaServico'].value) f['servico.itemListaServico'].value = p.itemListaPadrao;
  if (p.codigoTributacaoNacionalPadrao && !f['servico.codigoTributacaoNacional'].value) f['servico.codigoTributacaoNacional'].value = p.codigoTributacaoNacionalPadrao;
  else sugerirCodigoNacional();
  const info = $('[data-info-provedor]', f);
  const prov = await api(`/prestadores/${p.id}/provedor`);
  const cert = p.certificado
    ? `<span class="selo ${new Date(p.certificado.validoAte) < Date.now() + 30 * 864e5 ? 'selo-alerta' : 'selo-ok'}">Certificado válido até ${data(p.certificado.validoAte)}</span>`
    : '<span class="selo selo-erro">Sem certificado</span>';
  info.innerHTML = `<span class="selo selo-info">${h(NOME_PADRAO[prov.provedorEfetivo] || prov.provedorEfetivo)}</span>${seloAmbiente(p.ambiente)}${cert}<span>Próximo RPS: série ${h(p.serie)}, nº ${h(p.proximoNumero)}</span>`;
  $$('[data-so]', f).forEach((el) => el.classList.toggle('oculto', el.dataset.so !== prov.provedorEfetivo));
  recalcular();
}

function aoTrocarTipoTomador() {
  const f = $('#form-emitir');
  const t = f['tomador.tipo'].value;
  $$('[data-tomador=id]', f).forEach((el) => el.classList.toggle('oculto', t === 'NI'));
  $$('[data-tomador=br]', f).forEach((el) => el.classList.toggle('oculto', !['PJ', 'PF'].includes(t)));
  $$('[data-tomador=ext]', f).forEach((el) => el.classList.toggle('oculto', t !== 'EXT'));
  $('[data-rotulo-doc]', f).textContent = t === 'PF' ? 'CPF' : 'CNPJ';
}

function sugerirCodigoNacional() {
  const f = $('#form-emitir');
  const campo = f['servico.codigoTributacaoNacional'];
  const d = f['servico.itemListaServico'].value.replace(/\D/g, '');
  if (d.length >= 3 && !campo.dataset.manual) campo.value = d.padStart(4, '0') + '01';
}

async function buscarCep() {
  const f = $('#form-emitir');
  const cep = f['tomador.endereco.cep'].value.replace(/\D/g, '');
  if (cep.length !== 8) return;
  try {
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`).then((x) => x.json());
    if (r.erro) return;
    if (!f['tomador.endereco.logradouro'].value) f['tomador.endereco.logradouro'].value = r.logradouro || '';
    if (!f['tomador.endereco.bairro'].value) f['tomador.endereco.bairro'].value = r.bairro || '';
    f['tomador.endereco.codigoMunicipio'].value = r.ibge || '';
    f['tomador.endereco.uf'].value = r.uf || '';
  } catch { /* sem internet: preenchimento manual */ }
}

function notaDoForm() {
  const d = lerForm($('#form-emitir'));
  d.tomador ??= {};
  if (d.tomador.tipo === 'NI') d.tomador = { tipo: 'NI' };
  if (d.ibsCbs && !d.ibsCbs.cClassTrib) delete d.ibsCbs;
  if (d.ibsCbs) { d.ibsCbs.finNFSe = Number(d.ibsCbs.finNFSe); d.ibsCbs.indDest = Number(d.ibsCbs.indDest); }
  d.valores ??= {};
  d.valores.tributacaoIssqn = Number(d.valores.tributacaoIssqn || 1);
  return d;
}

let calcTimer;
function recalcular() {
  clearTimeout(calcTimer);
  calcTimer = setTimeout(async () => {
    const c = await api('/calcular', { metodo: 'POST', corpo: notaDoForm().valores }).catch(() => null);
    if (!c || !$('#resumo-valores')) return;
    const l = (a, b, cls = '') => `<dt class="${cls}">${a}</dt><dd class="${cls}">${b}</dd>`;
    $('#resumo-valores').innerHTML =
      l('Valor do serviço', brl(c.valorServico)) +
      (c.deducoes ? l('Deduções', '− ' + brl(c.deducoes)) : '') +
      (c.descontoIncondicionado ? l('Desconto incondicionado', '− ' + brl(c.descontoIncondicionado)) : '') +
      l('Base de cálculo', brl(c.baseCalculo)) +
      l(`ISS (${Number(c.aliquotaIss || 0).toLocaleString('pt-BR')}%)`, brl(c.valorIss)) +
      (c.valorIssRetido ? l('ISS retido', '− ' + brl(c.valorIssRetido)) : '') +
      (c.retencoesFederais ? l('Retenções federais', '− ' + brl(c.retencoesFederais)) : '') +
      (c.outrasRetencoes ? l('Outras retenções', '− ' + brl(c.outrasRetencoes)) : '') +
      (c.descontoCondicionado ? l('Desconto condicionado', '− ' + brl(c.descontoCondicionado)) : '') +
      l('Valor líquido', brl(c.valorLiquido), 'total');
  }, 150);
}

async function emitirNota() {
  const f = $('#form-emitir');
  const p = estado.prestadores.find((x) => x.id === f.prestadorId.value);
  if (p?.ambiente === 'producao' && !confirmar('Emitir esta nota em PRODUÇÃO? Ela terá valor fiscal.')) return;
  const botao = $('[data-botao-emitir]', f);
  const msgs = $('#emitir-msgs');
  botao.disabled = true; botao.textContent = 'Transmitindo…';
  msgs.innerHTML = '';
  try {
    const n = await api('/notas', { metodo: 'POST', corpo: notaDoForm(), headers: { 'Idempotency-Key': crypto.randomUUID() } });
    if (n.status === 'autorizada') {
      msgs.innerHTML = `<div class="mensagem ok"><b>Nota ${h(n.numero)} autorizada.</b><a href="#/notas/${n.id}">Ver nota</a></div>` + mensagensHtml(n.mensagens, 'alerta');
      toast('Nota autorizada.');
      await carregarPrestadores(); await aoTrocarPrestador();
    } else if (n.status === 'validada') {
      msgs.innerHTML = mensagensHtml(n.mensagens, 'ok');
    } else if (n.status === 'processando') {
      msgs.innerHTML = `<div class="mensagem alerta"><b>Sem resposta definitiva do fisco.</b>Consulte a situação em <a href="#/notas/${n.id}">Notas emitidas</a> antes de emitir de novo.</div>` + mensagensHtml(n.mensagens, 'alerta');
    } else {
      msgs.innerHTML = mensagensHtml(n.mensagens.length ? n.mensagens : [{ mensagem: 'Nota rejeitada pelo fisco.' }], 'erro');
      toast('Nota rejeitada. Veja os motivos abaixo do formulário.', 'erro');
    }
    msgs.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    msgs.innerHTML = mensagensHtml(e.erros?.length ? e.erros : [{ mensagem: e.message }], 'erro');
    msgs.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } finally {
    botao.disabled = false; botao.textContent = 'Emitir nota';
  }
}

function formatarXml(xml) {
  let nivel = 0;
  return String(xml || '').replace(/>\s*</g, '>\n<').split('\n').map((l) => {
    if (/^<\/\w/.test(l)) nivel = Math.max(0, nivel - 1);
    const out = '  '.repeat(nivel) + l;
    if (/^<\w[^>]*[^/]>$/.test(l) && !l.includes('</')) nivel++;
    return out;
  }).join('\n');
}

// ------------------------------------------------------------------ notas
async function telaNotas(alvo) {
  const prestadores = await carregarPrestadores();
  const f = estado.notasFiltro;
  alvo.innerHTML = `
    <div class="cabecalho-pagina"><div><h1>Notas emitidas</h1><p>Clique numa nota para ver detalhes, baixar o XML, imprimir ou cancelar.</p></div>
      <a class="btn btn-secundario" id="exportar-csv" href="#">Exportar planilha</a></div>
    <form class="barra-filtros" id="filtros">
      <input type="search" name="busca" placeholder="Tomador, CPF/CNPJ, número, chave ou referência" value="${h(f.busca || '')}">
      <select name="status"><option value="">Todas as situações</option>${Object.entries(SITUACAO).map(([k, [, t]]) => `<option value="${k}"${f.status === k ? ' selected' : ''}>${t}</option>`).join('')}</select>
      <select name="prestadorId"><option value="">Todas as empresas</option>${prestadores.map((p) => `<option value="${p.id}"${f.prestadorId === p.id ? ' selected' : ''}>${h(p.razaoSocial)}</option>`).join('')}</select>
      <select name="ambiente"><option value="">Produção e teste</option><option value="producao"${f.ambiente === 'producao' ? ' selected' : ''}>Só produção</option><option value="homologacao"${f.ambiente === 'homologacao' ? ' selected' : ''}>Só homologação</option></select>
      <label class="campo"><span class="sr">De</span><input type="date" name="de" value="${h(f.de || '')}" aria-label="Emitidas a partir de"></label>
      <label class="campo"><span class="sr">Até</span><input type="date" name="ate" value="${h(f.ate || '')}" aria-label="Emitidas até"></label>
    </form>
    <div id="lista-notas"><p class="carregando">Carregando…</p></div>`;
  const form = $('#filtros');
  let t;
  form.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { Object.assign(estado.notasFiltro, lerFiltros(), { pagina: 1 }); listarNotas(); }, 250); });
  form.addEventListener('submit', (e) => e.preventDefault());
  await listarNotas();
}

function lerFiltros() {
  const d = Object.fromEntries(new FormData($('#filtros')));
  for (const k of Object.keys(d)) if (!d[k]) delete d[k];
  return { busca: '', status: '', prestadorId: '', ambiente: '', de: '', ate: '', ...d };
}

async function listarNotas() {
  const params = new URLSearchParams(Object.entries(estado.notasFiltro).filter(([, v]) => v));
  $('#exportar-csv').href = `${API}/notas.csv?${params}`;
  const r = await api(`/notas?${params}&porPagina=25`);
  const paginas = Math.max(1, Math.ceil(r.total / r.porPagina));
  $('#lista-notas').innerHTML = tabelaNotas(r.itens) + (r.total > r.porPagina ? `<div class="paginacao"><span>${r.total} notas</span><span>
    <button class="btn btn-secundario btn-pequeno" data-acao="pagina" data-p="${r.pagina - 1}" ${r.pagina <= 1 ? 'disabled' : ''}>Anterior</button>
    Página ${r.pagina} de ${paginas}
    <button class="btn btn-secundario btn-pequeno" data-acao="pagina" data-p="${r.pagina + 1}" ${r.pagina >= paginas ? 'disabled' : ''}>Próxima</button></span></div>` : '');
}

async function telaNota(alvo, id) {
  const [n, eventos] = await Promise.all([api(`/notas/${id}`), api(`/notas/${id}/eventos`)]);
  const c = n.calculo || {};
  const t = n.tomador || {};
  const linha = (rotulo, valor, cls = '') => (valor || valor === 0 ? `<div class="${cls}"><dt>${rotulo}</dt><dd>${valor}</dd></div>` : '');
  const titulo = n.numero ? `Nota ${h(n.numero)}` : `RPS ${h(n.serie)}/${h(n.numeroRps)}`;
  const ehNacional = n.provedor === 'nacional';
  alvo.innerHTML = `
    <div class="cabecalho-pagina"><div><p><a href="#/notas">Notas emitidas</a></p><h1>${titulo}</h1>
      <p>${selo(n.status)} ${seloAmbiente(n.ambiente)} ${h(NOME_PADRAO[n.provedor] || n.provedor)}${n.municipio ? ', ' + h(n.municipio) : ''}</p></div>
      <div class="acoes-nota">
        ${pode('emitir') ? `<button class="btn btn-secundario" data-acao="consultar-nota" data-id="${n.id}">Consultar situação</button>` : ''}
        ${['autorizada', 'cancelada'].includes(n.status) ? `<a class="btn btn-secundario" target="_blank" rel="noopener" href="${API}/notas/${n.id}/${ehNacional ? 'danfse' : 'espelho'}">${ehNacional ? 'DANFSe (PDF)' : 'Imprimir'}</a>` : ''}
        <a class="btn btn-secundario" href="${API}/notas/${n.id}/xml">Baixar XML</a>
        ${n.status === 'autorizada' && pode('cancelar') ? `<button class="btn btn-perigo" data-acao="cancelar-nota" data-id="${n.id}">Cancelar nota</button>` : ''}
      </div></div>
    ${n.mensagens?.length ? `<div class="mensagens" style="margin-bottom:16px">${mensagensHtml(n.mensagens, n.status === 'autorizada' ? 'alerta' : 'erro')}</div>` : ''}
    <div class="detalhe">
      <div>
        <section class="bloco"><h2>Dados da nota</h2><dl class="dados">
          ${linha('Empresa emitente', h(n.prestadorNome))}
          ${linha('Competência', data(n.competencia))}
          ${linha('Chave de acesso', h(n.chaveAcesso), 'largo')}
          ${linha('Código de verificação', h(n.codigoVerificacao))}
          ${linha('Autorizada em', dataHora(n.dataAutorizacao))}
          ${linha('Referência interna', h(n.referenciaExterna))}
          ${n.linkConsulta ? linha('Consulta pública', `<a href="${h(n.linkConsulta)}" target="_blank" rel="noopener">Abrir no portal da prefeitura</a>`) : ''}
        </dl></section>
        <section class="bloco"><h2>Tomador</h2><dl class="dados">
          ${t.tipo === 'NI' ? '<div class="largo"><dd>Tomador não identificado</dd></div>' : `
          ${linha('Nome', h(t.nome), 'largo')}
          ${linha(t.tipo === 'EXT' ? 'NIF' : 'CPF/CNPJ', h(t.tipo === 'EXT' ? t.nif : fmtDoc(t.documento)))}
          ${linha('E-mail', h(t.email))}`}
        </dl></section>
        <section class="bloco"><h2>Serviço</h2><dl class="dados">
          ${linha('Descrição', h(n.servico?.discriminacao), 'largo')}
          ${linha('Item LC 116', h(n.servico?.itemListaServico))}
          ${linha('Cód. tributação nacional', h(n.servico?.codigoTributacaoNacional))}
        </dl></section>
      </div>
      <div>
        <section class="resumo"><h2>Valores</h2><dl>
          <dt>Valor do serviço</dt><dd>${brl(c.valorServico)}</dd>
          <dt>Base de cálculo</dt><dd>${brl(c.baseCalculo)}</dd>
          <dt>ISS (${Number(c.aliquotaIss || 0).toLocaleString('pt-BR')}%)</dt><dd>${brl(c.valorIss)}</dd>
          ${c.valorIssRetido ? `<dt>ISS retido</dt><dd>− ${brl(c.valorIssRetido)}</dd>` : ''}
          ${c.retencoesFederais ? `<dt>Retenções federais</dt><dd>− ${brl(c.retencoesFederais)}</dd>` : ''}
          <dt class="total">Valor líquido</dt><dd class="total">${brl(c.valorLiquido)}</dd>
        </dl></section>
        <section class="bloco" style="margin-top:16px"><h2>Histórico</h2><ul class="linha-tempo">
          ${eventos.map((e) => `<li><time>${dataHora(e.criado_em)}</time>${h({ emissao: 'Emissão', consulta: 'Consulta', cancelamento: 'Cancelamento' }[e.tipo] || e.tipo)}: ${h(SITUACAO[e.status]?.[1] || e.status || '')}${e.usuario ? ` <span class="sub">por ${h(e.usuario)}</span>` : ''}</li>`).join('')}
        </ul></section>
      </div>
    </div>`;
}

// ------------------------------------------------------------------ empresas
async function telaEmpresas(alvo) {
  const lista = await carregarPrestadores();
  const conta = estado.eu.conta;
  alvo.innerHTML = `
    <div class="cabecalho-pagina"><div><h1>Empresas emitentes</h1><p>Cada empresa tem seu certificado, numeração de RPS e ambiente. Seu plano permite ${conta.limites.prestadores}.</p></div>
      ${pode('prestadores') ? '<button class="btn btn-primario" data-acao="nova-empresa">Cadastrar empresa</button>' : ''}</div>
    ${lista.length ? `<div class="tabela-wrap"><table class="tabela"><thead><tr><th>Empresa</th><th>Município</th><th>Ambiente</th><th>Próximo RPS</th><th>Certificado</th></tr></thead><tbody>
    ${lista.map((p) => {
      const venc = p.certificado && new Date(p.certificado.validoAte);
      const cert = !venc ? '<span class="selo selo-erro">Não instalado</span>'
        : venc < Date.now() ? '<span class="selo selo-erro">Vencido</span>'
        : `<span class="selo ${venc < Date.now() + 30 * 864e5 ? 'selo-alerta' : 'selo-ok'}">Até ${data(p.certificado.validoAte)}</span>`;
      return `<tr class="${pode('prestadores') ? 'clicavel' : ''}" ${pode('prestadores') ? `data-acao="editar-empresa" data-id="${p.id}" tabindex="0"` : ''}>
        <td><strong>${h(p.razaoSocial)}</strong><span class="sub">${h(fmtDoc(p.documento))}${p.inscricaoMunicipal ? ', IM ' + h(p.inscricaoMunicipal) : ''}</span></td>
        <td>${h(p.municipio || '')}${p.uf ? '/' + h(p.uf) : ''}<span class="sub">IBGE ${h(p.codigoMunicipio)}</span></td>
        <td>${seloAmbiente(p.ambiente)}</td><td>${h(p.serie)}/${h(p.proximoNumero)}</td><td>${cert}</td></tr>`;
    }).join('')}</tbody></table></div>`
    : `<div class="tabela-wrap"><div class="vazio"><strong>Nenhuma empresa cadastrada</strong>Cadastre a primeira empresa emitente para começar a emitir notas.${pode('prestadores') ? '<br><button class="btn btn-primario" data-acao="nova-empresa">Cadastrar empresa</button>' : ''}</div></div>`}`;
}

function abrirEmpresa(p) {
  const dlg = $('#dlg-empresa');
  const f = $('#form-empresa');
  f.reset();
  f.provedor.innerHTML = '<option value="auto">Automático, pelo município</option>' + estado.info.provedores.map((x) => `<option value="${x.id}">${h(NOME_PADRAO[x.id] || x.nome)}</option>`).join('');
  preencherForm(f, p || { opSimpNac: 1, regApTribSN: 1, regEspTrib: 0, serie: '1', proximoNumero: 1, ambiente: 'homologacao', provedor: 'auto' });
  $('[data-titulo]', dlg).textContent = p ? p.razaoSocial : 'Nova empresa emitente';
  $('[data-acao=remover-empresa]', dlg).classList.toggle('oculto', !p);
  $('[data-certificado]', dlg).classList.toggle('oculto', !p);
  $('[data-cert-info]', dlg).innerHTML = p?.certificado
    ? `<strong>${h(p.certificado.titular)}</strong>, ${h(fmtDoc(p.certificado.documento || ''))}, válido até ${data(p.certificado.validoAte)}.${p.certificado.aviso ? `<br><span class="selo selo-alerta">${h(p.certificado.aviso)}</span>` : ''}`
    : 'Nenhum certificado instalado. Sem ele não é possível emitir.';
  $('.msg-form', dlg).textContent = '';
  atualizarCampoSimples();
  dlg.showModal();
}
function atualizarCampoSimples() {
  const f = $('#form-empresa');
  $('[data-se-simples]', f).classList.toggle('oculto', f.opSimpNac.value !== '3');
}
$('#form-empresa').opSimpNac.addEventListener('change', atualizarCampoSimples);

// ------------------------------------------------------------------ municípios
async function telaMunicipios(alvo) {
  const lista = await api('/municipios');
  const linhas = Object.entries(lista);
  alvo.innerHTML = `
    <div class="cabecalho-pagina"><div><h1>Municípios</h1><p>Todo município emite pelo Portal Nacional, exceto os listados abaixo, que usam o sistema próprio da prefeitura.</p></div>
      ${pode('municipios') ? '<button class="btn btn-primario" data-acao="novo-municipio">Cadastrar prefeitura</button>' : ''}</div>
    <div class="tabela-wrap"><table class="tabela"><thead><tr><th>Município</th><th>Padrão</th><th>Configuração</th><th></th></tr></thead><tbody>
      <tr><td><strong>Demais municípios</strong></td><td><span class="selo selo-info">Portal Nacional</span></td><td>Sefin Nacional e ADN, automático</td><td></td></tr>
      ${linhas.map(([cod, m]) => `<tr>
        <td><strong>${h(m.nome)}${m.uf ? '/' + h(m.uf) : ''}</strong><span class="sub">IBGE ${h(cod)}${m.observacao ? '. ' + h(m.observacao) : ''}</span></td>
        <td><span class="selo selo-neutro">${h(NOME_PADRAO[m.provedor] || m.provedor)}</span></td>
        <td>${{ conta: 'Configurado pela sua equipe', plataforma: 'Configurado pela plataforma', padrao: 'Integração nativa' }[m.origem] || ''}</td>
        <td class="acoes">${pode('municipios') && m.origem === 'conta' ? `<button class="btn btn-texto btn-pequeno" data-acao="editar-municipio" data-codigo="${cod}">Editar</button><button class="btn btn-texto btn-pequeno" data-acao="remover-municipio" data-codigo="${cod}">Remover</button>` : ''}</td>
      </tr>`).join('')}
    </tbody></table></div>`;
  estado.municipios = lista;
}

function abrirMunicipio(codigo) {
  const m = codigo ? estado.municipios[codigo] : { provedor: 'abrasf', preset: 'abrasf-2.04' };
  const f = $('#form-municipio');
  f.reset();
  f.provedor.innerHTML = estado.info.provedores.filter((p) => p.id !== 'nacional').map((p) => `<option value="${p.id}">${h(NOME_PADRAO[p.id] || p.nome)}</option>`).join('');
  f.preset.innerHTML = estado.info.presetsAbrasf.map((p) => `<option value="${p.id}">${h(p.nome)}</option>`).join('');
  preencherForm(f, { ...m, codigo, urlHomologacao: m.urls?.homologacao, urlProducao: m.urls?.producao, opcoes: m.opcoes ? JSON.stringify(m.opcoes, null, 2) : '' });
  f.codigo.readOnly = !!codigo;
  const sincronizar = () => $('[data-so-abrasf]', f).classList.toggle('oculto', f.provedor.value !== 'abrasf');
  f.provedor.onchange = sincronizar; sincronizar();
  $('.msg-form', f).textContent = '';
  $('#dlg-municipio').showModal();
}

// ------------------------------------------------------------------ equipe
async function telaEquipe(alvo) {
  const { membros, convites } = await api('/equipe');
  const conta = estado.eu.conta;
  const eu = estado.eu.usuario.id;
  const gerencia = pode('equipe');
  const opcoes = (atual) => ['admin', 'emissor', 'leitura', ...(estado.eu.papel === 'dono' ? ['dono'] : [])]
    .map((p) => `<option value="${p}"${p === atual ? ' selected' : ''}>${NOME_PAPEL[p]}</option>`).join('');
  alvo.innerHTML = `
    <div class="cabecalho-pagina"><div><h1>Equipe</h1><p>${membros.length} de ${conta.limites.usuarios} usuários do plano. Administradores gerenciam empresas e equipe; emissores emitem e cancelam; leitura só consulta.</p></div></div>
    ${gerencia ? `<form class="bloco" id="form-convite"><h2>Convidar pessoa</h2><div class="grade">
      <label class="campo c6"><span>E-mail</span><input name="email" type="email" required></label>
      <label class="campo c4"><span>Perfil de acesso</span><select name="papel"><option value="emissor">Emissor</option><option value="admin">Administrador</option><option value="leitura">Somente leitura</option></select></label>
      <div class="c2 alinhar-base"><button class="btn btn-primario" type="submit">Enviar convite</button></div></div></form>` : ''}
    <div class="tabela-wrap"><table class="tabela"><thead><tr><th>Pessoa</th><th>Perfil</th><th>Último acesso</th><th></th></tr></thead><tbody>
      ${membros.map((m) => `<tr><td><strong>${h(m.nome)}</strong>${m.id === eu ? ' <span class="selo selo-neutro">Você</span>' : ''}<span class="sub">${h(m.email)}</span></td>
        <td>${gerencia && m.id !== eu && m.papel !== 'dono' ? `<select data-acao-change="papel" data-id="${m.id}" aria-label="Perfil de ${h(m.nome)}">${opcoes(m.papel)}</select>` : h(NOME_PAPEL[m.papel])}</td>
        <td>${dataHora(m.ultimo_login_em) || 'Nunca'}</td>
        <td class="acoes">${gerencia && m.id !== eu && m.papel !== 'dono' ? `<button class="btn btn-texto btn-pequeno" data-acao="remover-membro" data-id="${m.id}">Remover</button>` : ''}</td></tr>`).join('')}
      ${convites.map((c) => `<tr><td><strong>${h(c.email)}</strong><span class="sub">Convite enviado, válido até ${data(c.expira_em)}</span></td><td>${h(NOME_PAPEL[c.papel])}</td><td>Pendente</td>
        <td class="acoes">${gerencia ? `<button class="btn btn-texto btn-pequeno" data-acao="cancelar-convite" data-id="${c.id}">Cancelar convite</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
  $('#form-convite')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/equipe/convites', { metodo: 'POST', corpo: lerForm(e.target) });
      toast('Convite enviado.');
      navegar();
    } catch (x) { toast(x.message, 'erro'); }
  });
}

// ------------------------------------------------------------------ integrações
async function telaIntegracoes(alvo) {
  const conta = estado.eu.conta;
  if (!conta.limites.api) {
    alvo.innerHTML = `<div class="cabecalho-pagina"><div><h1>Integrações</h1></div></div><div class="tabela-wrap"><div class="vazio"><strong>Disponível a partir do plano Profissional</strong>Conecte seu ERP ou sistema de faturamento para emitir notas automaticamente.<br><a class="btn btn-primario" href="#/conta">Ver planos</a></div></div>`;
    return;
  }
  const [chaves, hooks, entregas] = await Promise.all([api('/chaves'), api('/webhooks'), api('/webhooks/entregas')]);
  alvo.innerHTML = `
    <div class="cabecalho-pagina"><div><h1>Integrações</h1><p>Emita notas a partir do seu sistema pela API e receba avisos quando a situação mudar. <a href="/docs.html" target="_blank" rel="noopener">Documentação da API</a></p></div></div>
    <section class="bloco"><h2>Chaves de acesso à API</h2>
      <form id="form-chave" class="grade" style="margin-bottom:16px">
        <label class="campo c6"><span>Nome da chave</span><input name="nome" placeholder="Ex.: ERP financeiro" required></label>
        <label class="campo c4"><span>Pode</span><select name="papel"><option value="emissor">Emitir e consultar</option><option value="leitura">Só consultar</option><option value="admin">Tudo, inclusive empresas</option></select></label>
        <div class="c2 alinhar-base"><button class="btn btn-primario" type="submit">Criar chave</button></div>
      </form>
      ${chaves.length ? `<table class="tabela"><thead><tr><th>Nome</th><th>Início da chave</th><th>Último uso</th><th></th></tr></thead><tbody>
        ${chaves.map((k) => `<tr><td>${h(k.nome)}<span class="sub">${h(NOME_PAPEL[k.papel])}, criada em ${data(k.criado_em)}</span></td><td>${h(k.prefixo)}…</td>
          <td>${k.revogada_em ? '<span class="selo selo-neutro">Revogada</span>' : dataHora(k.ultimo_uso_em) || 'Nunca usada'}</td>
          <td class="acoes">${k.revogada_em ? '' : `<button class="btn btn-texto btn-pequeno" data-acao="revogar-chave" data-id="${k.id}">Revogar</button>`}</td></tr>`).join('')}
      </tbody></table>` : '<p class="sub">Nenhuma chave criada.</p>'}
    </section>
    <section class="bloco"><h2>Avisos automáticos (webhooks)</h2>
      <p class="sub" style="margin-bottom:12px">Enviamos um POST assinado para o endereço informado quando uma nota é autorizada, rejeitada, cancelada ou fica aguardando resposta.</p>
      <form id="form-webhook" class="grade" style="margin-bottom:16px">
        <label class="campo c10" style="grid-column:span 10"><span>Endereço que vai receber os avisos</span><input name="url" type="url" placeholder="https://seusistema.com.br/nfse/avisos" required></label>
        <div class="c2 alinhar-base"><button class="btn btn-primario" type="submit">Adicionar</button></div>
      </form>
      ${hooks.length ? `<table class="tabela"><tbody>${hooks.map((w) => `<tr><td>${h(w.url)}<span class="sub">${w.eventos.map(h).join(', ')}</span></td>
        <td class="acoes"><button class="btn btn-texto btn-pequeno" data-acao="remover-webhook" data-id="${w.id}">Remover</button></td></tr>`).join('')}</tbody></table>` : ''}
      ${entregas.length ? `<h3 style="font-size:15px;margin:20px 0 8px">Últimos envios</h3><table class="tabela"><thead><tr><th>Evento</th><th>Destino</th><th>Resultado</th><th>Quando</th></tr></thead><tbody>
        ${entregas.slice(0, 15).map((e) => `<tr><td>${h(e.evento)}</td><td>${h(e.url)}</td><td>${e.entregue_em ? '<span class="selo selo-ok">Entregue</span>' : `<span class="selo selo-erro">${h(e.erro || 'Pendente')}</span><span class="sub">${e.tentativas} tentativa(s)</span>`}</td><td>${dataHora(e.criado_em)}</td></tr>`).join('')}
      </tbody></table>` : ''}
    </section>`;
  $('#form-chave').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const k = await api('/chaves', { metodo: 'POST', corpo: lerForm(e.target) });
      mostrarSegredo('Chave criada', 'Copie a chave agora. Por segurança, ela não será exibida de novo. Use no cabeçalho Authorization: Bearer <chave>.', k.token);
      navegar();
    } catch (x) { toast(x.message, 'erro'); }
  });
  $('#form-webhook').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const w = await api('/webhooks', { metodo: 'POST', corpo: lerForm(e.target) });
      mostrarSegredo('Aviso automático criado', 'Use este segredo para validar a assinatura do cabeçalho X-Assinatura. Ele não será exibido de novo.', w.segredo);
      navegar();
    } catch (x) { toast(x.message, 'erro'); }
  });
}

function mostrarSegredo(titulo, texto, segredo) {
  const d = $('#dlg-segredo');
  $('[data-titulo]', d).textContent = titulo;
  $('[data-texto]', d).textContent = texto;
  $('[data-segredo]', d).textContent = segredo;
  d.showModal();
}

// ------------------------------------------------------------------ conta e plano
async function telaConta(alvo) {
  const [conta, auditoria] = await Promise.all([api('/conta'), pode('equipe') ? api('/auditoria?limite=30') : Promise.resolve([])]);
  const planos = estado.info.planos.filter((p) => p.id !== 'teste');
  const suporte = estado.info.suporte;
  alvo.innerHTML = `
    <div class="cabecalho-pagina"><div><h1>Plano e conta</h1></div></div>
    <div class="duas-colunas">
      <section class="bloco"><h2>Plano atual: ${h(conta.nomePlano)}</h2>
        <p class="sub" style="margin-bottom:14px">${conta.plano === 'teste' ? (conta.testeExpirado ? 'O período de teste terminou.' : `Teste grátis até ${data(conta.testeAte)}.`) : 'Assinatura ativa.'}</p>
        <table class="tabela"><thead><tr><th>Plano</th><th class="num">Notas/mês</th><th class="num">Empresas</th><th class="num">Usuários</th><th>API</th><th class="num">Mensal</th></tr></thead><tbody>
          ${planos.map((p) => `<tr${p.id === conta.plano ? ' style="background:var(--carimbo-claro)"' : ''}><td><strong>${h(p.nome)}</strong>${p.id === conta.plano ? ' <span class="selo selo-info">Atual</span>' : ''}</td>
            <td class="num">${p.notasMes.toLocaleString('pt-BR')}</td><td class="num">${p.prestadores}</td><td class="num">${p.usuarios}</td><td>${p.api ? 'Sim' : 'Não'}</td><td class="num">${brl(p.preco)}</td></tr>`).join('')}
        </tbody></table>
        <p style="margin-top:14px">${suporte ? `Para assinar ou mudar de plano, escreva para <a href="mailto:${h(suporte)}?subject=${encodeURIComponent('Assinatura — ' + conta.nome)}">${h(suporte)}</a>.` : 'Para assinar ou mudar de plano, fale com o suporte.'}</p>
      </section>
      <div>
        ${pode('conta') ? `<form class="bloco" id="form-conta"><h2>Dados da conta</h2>
          <label class="campo"><span>Nome da empresa ou escritório</span><input name="nome" value="${h(conta.nome)}" required></label>
          <label class="campo" style="margin-top:12px"><span>CNPJ para faturamento <small>opcional</small></span><input name="documento" value="${h(conta.documento || '')}"></label>
          <button class="btn btn-primario" style="margin-top:14px">Salvar</button></form>` : ''}
        <form class="bloco" id="form-senha"><h2>Trocar minha senha</h2>
          <label class="campo"><span>Senha atual</span><input name="atual" type="password" autocomplete="current-password" required></label>
          <label class="campo" style="margin-top:12px"><span>Nova senha</span><input name="nova" type="password" autocomplete="new-password" minlength="8" required></label>
          <button class="btn btn-secundario" style="margin-top:14px">Trocar senha</button></form>
      </div>
    </div>
    ${auditoria.length ? `<div class="secao-titulo"><h2>Atividade recente</h2></div><div class="tabela-wrap"><table class="tabela"><thead><tr><th>Quando</th><th>Quem</th><th>O quê</th><th>IP</th></tr></thead><tbody>
      ${auditoria.map((a) => `<tr><td>${dataHora(a.criado_em)}</td><td>${h(a.usuario || (a.chave_api ? 'API: ' + a.chave_api : 'Sistema'))}</td><td>${h(DESCRICAO_ACAO[a.acao] || a.acao)}</td><td>${h(a.ip || '')}</td></tr>`).join('')}
    </tbody></table></div>` : ''}`;
  $('#form-conta')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/conta', { metodo: 'PUT', corpo: lerForm(e.target) }); toast('Dados salvos.'); await carregarSessao(); } catch (x) { toast(x.message, 'erro'); }
  });
  $('#form-senha').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/auth/senha', { metodo: 'POST', corpo: lerForm(e.target) }); e.target.reset(); toast('Senha alterada.'); } catch (x) { toast(x.message, 'erro'); }
  });
}

const DESCRICAO_ACAO = {
  'nota.emitir': 'Emitiu uma nota', 'nota.cancelar': 'Cancelou uma nota', 'prestador.criar': 'Cadastrou empresa',
  'prestador.atualizar': 'Alterou empresa', 'prestador.remover': 'Removeu empresa', 'prestador.certificado': 'Instalou certificado',
  'equipe.convidar': 'Convidou pessoa', 'equipe.aceitar_convite': 'Entrou na equipe', 'equipe.alterar_papel': 'Alterou perfil de acesso',
  'equipe.remover': 'Removeu pessoa', 'api.criar_chave': 'Criou chave de API', 'api.revogar_chave': 'Revogou chave de API',
  'webhook.criar': 'Criou aviso automático', 'conta.criar': 'Criou a conta', 'conta.atualizar': 'Alterou dados da conta',
  'municipio.salvar': 'Configurou prefeitura', 'usuario.trocar_senha': 'Trocou a senha', 'admin.alterar_conta': 'Plataforma alterou o plano',
};

// ------------------------------------------------------------------ administração
async function telaAdmin(alvo) {
  if (!estado.eu.usuario.superadmin) { location.hash = '#/painel'; return; }
  const [resumo, contas] = await Promise.all([api('/admin/resumo'), api('/admin/contas')]);
  const planos = estado.info.planos;
  alvo.innerHTML = `
    <div class="cabecalho-pagina"><div><h1>Administração da plataforma</h1><p>Contas de clientes, planos e situação.</p></div></div>
    <dl class="indicadores">
      <div class="indicador"><dt>Contas</dt><dd>${resumo.contas}</dd></div>
      <div class="indicador"><dt>Pagantes</dt><dd>${resumo.pagantes}</dd></div>
      <div class="indicador"><dt>Usuários</dt><dd>${resumo.usuarios}</dd></div>
      <div class="indicador"><dt>Notas no mês</dt><dd>${resumo.notas_mes}</dd></div>
    </dl>
    <div class="tabela-wrap"><table class="tabela"><thead><tr><th>Conta</th><th>Plano</th><th>Situação</th><th>Teste até</th><th class="num">Empresas</th><th class="num">Notas no mês</th><th>Criada</th></tr></thead><tbody>
      ${contas.map((c) => `<tr><td><strong>${h(c.nome)}</strong><span class="sub">${h(c.dono || '')}</span></td>
        <td><select data-acao-change="admin-plano" data-id="${c.id}" aria-label="Plano de ${h(c.nome)}">${planos.map((p) => `<option value="${p.id}"${p.id === c.plano ? ' selected' : ''}>${h(p.nome)}</option>`).join('')}</select></td>
        <td><select data-acao-change="admin-status" data-id="${c.id}" aria-label="Situação de ${h(c.nome)}">${['ativa', 'suspensa', 'cancelada'].map((s) => `<option${s === c.status ? ' selected' : ''}>${s}</option>`).join('')}</select></td>
        <td><input type="date" value="${c.teste_ate ? c.teste_ate.slice(0, 10) : ''}" data-acao-change="admin-teste" data-id="${c.id}" aria-label="Fim do teste de ${h(c.nome)}"></td>
        <td class="num">${c.prestadores}</td><td class="num">${c.notas_mes}</td><td>${data(c.criado_em)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

// ------------------------------------------------------------------ ações (delegação)
const ACOES = {
  sair: async () => { await api('/auth/sair', { metodo: 'POST' }); location.assign('/entrar.html'); },
  'abrir-menu': () => $('#lateral').classList.toggle('aberta'),
  'abrir-nota': (el) => { location.hash = `#/notas/${el.dataset.id}`; },
  pagina: (el) => { estado.notasFiltro.pagina = Number(el.dataset.p); listarNotas(); },
  'limpar-emissao': () => { navegar(); },
  'ver-xml': async () => {
    try {
      const r = await api('/notas/previsualizar', { metodo: 'POST', corpo: notaDoForm() });
      const d = $('#dlg-xml');
      $('[data-titulo]', d).textContent = `XML para ${NOME_PADRAO[r.provedor] ? NOME_PADRAO[r.provedor] : r.provedor}${r.assinado ? ', assinado' : ', sem assinatura (instale o certificado)'}`;
      $('[data-xml]', d).textContent = formatarXml(r.xml);
      d.showModal();
    } catch (e) { $('#emitir-msgs').innerHTML = mensagensHtml(e.erros?.length ? e.erros : [{ mensagem: e.message }], 'erro'); }
  },
  'consultar-nota': async (el) => {
    el.disabled = true;
    try { const n = await api(`/notas/${el.dataset.id}/consultar`, { metodo: 'POST' }); toast(`Situação: ${SITUACAO[n.status]?.[1] || n.status}.`); navegar(); }
    catch (e) { toast(e.message, 'erro'); el.disabled = false; }
  },
  'cancelar-nota': (el) => {
    const f = $('#form-cancelar');
    f.reset(); f.id.value = el.dataset.id;
    f.codigo.innerHTML = Object.entries(estado.info.motivosCancelamento).map(([k, v]) => `<option value="${k}">${h(v)}</option>`).join('');
    $('.msg-form', f).textContent = '';
    $('#dlg-cancelar').showModal();
  },
  'confirmar-cancelamento': async (el) => {
    const f = $('#form-cancelar');
    el.disabled = true;
    try {
      const r = await api(`/notas/${f.id.value}/cancelar`, { metodo: 'POST', corpo: { codigo: Number(f.codigo.value), motivo: f.motivo.value.trim() } });
      if (r.sucesso) { $('#dlg-cancelar').close(); toast('Nota cancelada.'); navegar(); }
      else $('.msg-form', f).textContent = 'O fisco recusou o cancelamento: ' + (r.mensagens || []).map((m) => m.mensagem).join(' ');
    } catch (e) { $('.msg-form', f).textContent = e.message; } finally { el.disabled = false; }
  },
  'nova-empresa': () => abrirEmpresa(null),
  'editar-empresa': (el) => abrirEmpresa(estado.prestadores.find((p) => p.id === el.dataset.id)),
  'salvar-empresa': async (el) => {
    const f = $('#form-empresa');
    const d = lerForm(f);
    for (const k of ['opSimpNac', 'regApTribSN', 'regEspTrib']) if (d[k] !== undefined) d[k] = Number(d[k]);
    delete d.senhaPfx;
    el.disabled = true;
    try {
      const p = await api(d.id ? `/prestadores/${d.id}` : '/prestadores', { metodo: d.id ? 'PUT' : 'POST', corpo: d });
      await carregarPrestadores();
      toast(d.id ? 'Empresa salva.' : 'Empresa cadastrada. Agora instale o certificado.');
      abrirEmpresa(estado.prestadores.find((x) => x.id === p.id));
      if (location.hash.startsWith('#/empresas')) telaEmpresas($('#conteudo'));
    } catch (e) { $('.msg-form', f).textContent = e.message; } finally { el.disabled = false; }
  },
  'instalar-certificado': async (el) => {
    const f = $('#form-empresa');
    const arq = f.pfx.files[0];
    if (!arq) { $('.msg-form', f).textContent = 'Escolha o arquivo do certificado (.pfx ou .p12).'; return; }
    const bytes = new Uint8Array(await arq.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    el.disabled = true;
    try {
      await api(`/prestadores/${f.id.value}/certificado`, { metodo: 'POST', corpo: { pfxBase64: btoa(bin), senha: f.senhaPfx.value } });
      await carregarPrestadores();
      toast('Certificado instalado.');
      abrirEmpresa(estado.prestadores.find((x) => x.id === f.id.value));
      if (location.hash.startsWith('#/empresas')) telaEmpresas($('#conteudo'));
    } catch (e) { $('.msg-form', f).textContent = e.message; } finally { el.disabled = false; }
  },
  'remover-empresa': async () => {
    const f = $('#form-empresa');
    if (!confirmar('Remover esta empresa? O certificado será apagado. As notas já emitidas continuam no histórico.')) return;
    await api(`/prestadores/${f.id.value}`, { metodo: 'DELETE' });
    $('#dlg-empresa').close(); toast('Empresa removida.'); navegar();
  },
  'novo-municipio': () => abrirMunicipio(null),
  'editar-municipio': (el) => abrirMunicipio(el.dataset.codigo),
  'remover-municipio': async (el) => {
    if (!confirmar('Remover esta configuração? O município passa a emitir pelo Portal Nacional.')) return;
    await api(`/municipios/${el.dataset.codigo}`, { metodo: 'DELETE' }); navegar();
  },
  'salvar-municipio': async () => {
    const f = $('#form-municipio');
    const d = lerForm(f);
    let opcoes;
    try { opcoes = d.opcoes ? JSON.parse(d.opcoes) : undefined; } catch { $('.msg-form', f).textContent = 'Os ajustes avançados não são um JSON válido.'; return; }
    try {
      await api(`/municipios/${d.codigo}`, { metodo: 'PUT', corpo: {
        nome: d.nome, uf: (d.uf || '').toUpperCase(), provedor: d.provedor, preset: d.provedor === 'abrasf' ? d.preset : undefined,
        urls: { homologacao: d.urlHomologacao, producao: d.urlProducao }, observacao: d.observacao, opcoes } });
      $('#dlg-municipio').close(); toast('Prefeitura configurada.'); navegar();
    } catch (e) { $('.msg-form', f).textContent = e.message; }
  },
  'remover-membro': async (el) => {
    if (!confirmar('Remover esta pessoa da equipe?')) return;
    try { await api(`/equipe/${el.dataset.id}`, { metodo: 'DELETE' }); navegar(); } catch (e) { toast(e.message, 'erro'); }
  },
  'cancelar-convite': async (el) => { await api(`/equipe/convites/${el.dataset.id}`, { metodo: 'DELETE' }); navegar(); },
  'revogar-chave': async (el) => {
    if (!confirmar('Revogar esta chave? Sistemas que a usam deixarão de funcionar na hora.')) return;
    await api(`/chaves/${el.dataset.id}`, { metodo: 'DELETE' }); navegar();
  },
  'remover-webhook': async (el) => { await api(`/webhooks/${el.dataset.id}`, { metodo: 'DELETE' }); navegar(); },
  'copiar-segredo': async () => {
    try { await navigator.clipboard.writeText($('#dlg-segredo [data-segredo]').textContent); toast('Copiado.'); } catch { toast('Selecione e copie manualmente.', 'erro'); }
  },
};

const ACOES_CHANGE = {
  papel: async (el) => {
    try { await api(`/equipe/${el.dataset.id}`, { metodo: 'PUT', corpo: { papel: el.value } }); toast('Perfil alterado.'); if (el.value === 'dono') location.reload(); }
    catch (e) { toast(e.message, 'erro'); navegar(); }
  },
  'admin-plano': (el) => alterarConta(el.dataset.id, { plano: el.value }),
  'admin-status': (el) => alterarConta(el.dataset.id, { status: el.value }),
  'admin-teste': (el) => el.value && alterarConta(el.dataset.id, { testeAte: el.value + 'T23:59:59-03:00' }),
};
async function alterarConta(id, corpo) {
  try { await api(`/admin/contas/${id}`, { metodo: 'PUT', corpo }); toast('Conta atualizada.'); } catch (e) { toast(e.message, 'erro'); }
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-acao]');
  if (!el || el.disabled) return;
  ev.preventDefault();
  Promise.resolve(ACOES[el.dataset.acao]?.(el, ev)).catch((e) => toast(e.message, 'erro'));
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.matches('tr[data-acao]')) ACOES[ev.target.dataset.acao]?.(ev.target);
});
document.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-acao-change]');
  if (el) ACOES_CHANGE[el.dataset.acaoChange]?.(el);
});
$('#seletor-conta').addEventListener('change', async (e) => {
  await api('/auth/conta-ativa', { metodo: 'POST', corpo: { contaId: e.target.value } });
  location.hash = '#/painel';
  location.reload();
});
window.addEventListener('hashchange', navegar);
// Enter dentro de um diálogo não deve fechá-lo; só os botões "Fechar/Voltar" fecham.
$$('dialog form').forEach((f) => f.addEventListener('submit', (e) => { if (!e.submitter?.value) e.preventDefault(); }));

// ------------------------------------------------------------------ início
(async () => {
  try {
    await carregarSessao();
  } catch { return; }
  if (location.hash === '#boas-vindas') location.hash = '#/painel';
  navegar();
})();
