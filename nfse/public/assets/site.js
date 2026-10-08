document.getElementById('ano').textContent = new Date().getFullYear();

const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const LINHAS = [
  ['Notas autorizadas em produção por mês', (p) => p.notasMes.toLocaleString('pt-BR')],
  ['Empresas emitentes (CNPJ)', (p) => p.prestadores],
  ['Usuários', (p) => p.usuarios],
  ['Portal Nacional, ABRASF e São Paulo', () => '<span class="sim">Incluído</span>'],
  ['Homologação ilimitada', () => '<span class="sim">Incluído</span>'],
  ['API e avisos automáticos (webhooks)', (p) => (p.api ? '<span class="sim">Incluído</span>' : '<span class="nao">—</span>')],
];

async function carregarPlanos() {
  const tabela = document.getElementById('tabela-planos');
  try {
    const { planos } = await fetch('/api/v1/info').then((r) => r.json());
    const pagos = planos.filter((p) => p.id !== 'teste');
    const destaque = 'profissional';
    const cab = tabela.querySelector('thead tr');
    for (const p of pagos) {
      const th = document.createElement('th');
      th.scope = 'col';
      if (p.id === destaque) th.className = 'destaque';
      th.innerHTML = `${p.nome}<span class="preco">${brl(p.preco)}<small>/mês</small></span>`;
      cab.appendChild(th);
    }
    tabela.querySelector('tbody').innerHTML = LINHAS.map(([rotulo, f]) =>
      `<tr><th scope="row">${rotulo}</th>${pagos.map((p) => `<td${p.id === destaque ? ' class="destaque"' : ''}>${f(p)}</td>`).join('')}</tr>`).join('');
  } catch {
    tabela.closest('.tabela-planos-wrap').innerHTML = '<p style="padding:20px">Não foi possível carregar os planos agora.</p>';
  }
}
carregarPlanos();
