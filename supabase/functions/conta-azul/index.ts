// Edge Function: ponte entre a página conciliacao.html e a API v2 do Conta Azul.
//
// Secrets (supabase secrets set ...):
//   CONTA_AZUL_CLIENT_ID, CONTA_AZUL_CLIENT_SECRET  – app do Portal do Desenvolvedor
//   CONTA_AZUL_REDIRECT_URI – URL desta função (…/functions/v1/conta-azul)
//   CONTA_AZUL_AUTH_URL, CONTA_AZUL_TOKEN_URL       – (opcionais) endereços de login/token
//   APP_URL                 – URL da página conciliacao.html (volta após o login)
//   ROBO_KEY                – senha que a página envia no header x-robo-key
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem em toda Edge Function.
//
// Vários clientes: a página envia o header x-cliente (padrão "principal"); cada
// cliente tem a sua conexão em conta_azul_conexoes e o seu histórico no log.
//
// Comprovantes NÃO são enviados: a API pública do Conta Azul não tem rota para
// anexar arquivo a parcela/baixa (conferido em out/2026). O robô só os identifica.
//
// Deploy: supabase functions deploy conta-azul --no-verify-jwt
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const AUTH_URL = Deno.env.get('CONTA_AZUL_AUTH_URL') ?? 'https://auth.contaazul.com/login';
const TOKEN_URL = Deno.env.get('CONTA_AZUL_TOKEN_URL') ?? 'https://auth.contaazul.com/oauth2/token';
const API = Deno.env.get('CONTA_AZUL_API_URL') ?? 'https://api-v2.contaazul.com';
const SCOPE = 'openid profile aws.cognito.signin.user.admin';

const CLIENT_ID = Deno.env.get('CONTA_AZUL_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('CONTA_AZUL_CLIENT_SECRET') ?? '';
const REDIRECT_URI = Deno.env.get('CONTA_AZUL_REDIRECT_URI') ?? '';
const APP_URL = Deno.env.get('APP_URL') ?? '';
const ROBO_KEY = Deno.env.get('ROBO_KEY') ?? '';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-action, x-robo-key, x-cliente, authorization, apikey',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const slug = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// ---------- tokens (por cliente) ----------
async function trocarToken(cliente: string, params: Record<string, string>) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`),
    },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  if (!r.ok) throw new Error(`Token Conta Azul ${r.status}: ${await r.text()}`);
  const t = await r.json();
  const row: Record<string, unknown> = {
    access_token: t.access_token,
    expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000 - 60_000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  // o refresh pode não vir de novo na renovação — mantém o anterior
  if (t.refresh_token) row.refresh_token = t.refresh_token;
  const { error } = await db.from('conta_azul_conexoes').update(row).eq('cliente', cliente);
  if (error) throw error;
  return t.access_token as string;
}

async function accessToken(cliente: string): Promise<string> {
  const { data, error } = await db.from('conta_azul_conexoes').select('*').eq('cliente', cliente).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Cliente não encontrado. Selecione ou cadastre o cliente.');
  if (!data.refresh_token) throw new Error('Conta Azul não conectado para este cliente. Clique em "Conectar Conta Azul".');
  if (data.access_token && new Date(data.expires_at) > new Date()) return data.access_token;
  return trocarToken(cliente, { grant_type: 'refresh_token', refresh_token: data.refresh_token });
}

async function caRaw(cliente: string, path: string, init: RequestInit = {}) {
  return fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken(cliente)}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}
async function ca(cliente: string, path: string, init: RequestInit = {}) {
  const r = await caRaw(cliente, path, init);
  const txt = await r.text();
  const body = txt ? (() => { try { return JSON.parse(txt); } catch { return txt; } })() : null;
  if (!r.ok) throw new Error(`Conta Azul ${r.status} em ${path.split('?')[0]}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}
const itensDe = (r: any) => r?.itens ?? r?.items ?? (Array.isArray(r) ? r : []);

// ---------- consultas ----------
async function listarParcelas(cliente: string, tipo: 'receber' | 'pagar', de: string, ate: string) {
  const out: unknown[] = [];
  for (let pagina = 1; pagina <= 50; pagina++) {
    const q = new URLSearchParams({
      pagina: String(pagina), tamanho_pagina: '100',
      data_vencimento_de: de, data_vencimento_ate: ate,
    });
    for (const s of ['EM_ABERTO', 'ATRASADO', 'RECEBIDO_PARCIAL']) q.append('status', s);
    const itens = itensDe(await ca(cliente, `/v1/financeiro/eventos-financeiros/contas-a-${tipo}/buscar?${q}`));
    for (const i of itens) {
      out.push({
        id: i.id,
        tipo,
        vencimento: String(i.data_vencimento ?? i.vencimento ?? '').slice(0, 10),
        valor: Number(i.nao_pago ?? i.valor_em_aberto ?? i.total ?? i.valor ?? 0),
        nome: i.cliente?.nome ?? i.fornecedor?.nome ?? i.contato?.nome ?? '',
        descricao: i.descricao ?? '',
        status: i.status,
      });
    }
    if (itens.length < 100) break;
  }
  return out;
}

async function contasFinanceiras(cliente: string) {
  const r = await ca(cliente, '/v1/conta-financeira?pagina=1&tamanho_pagina=100&apenas_ativo=true');
  return itensDe(r).map((c: any) => ({ id: c.id, nome: c.nome, banco: c.banco, tipo: c.tipo }));
}

async function categorias(cliente: string, tipo: string) {
  const out: any[] = [];
  for (let pagina = 1; pagina <= 10; pagina++) {
    const q = new URLSearchParams({ pagina: String(pagina), tamanho_pagina: '100', permite_apenas_filhos: 'true',
      campo_ordenado_ascendente: 'NOME' });
    if (tipo) q.set('tipo', tipo);
    const itens = itensDe(await ca(cliente, `/v1/categorias?${q}`));
    out.push(...itens.map((c: any) => ({ id: c.id, nome: c.nome, tipo: c.tipo })));
    if (itens.length < 100) break;
  }
  return out;
}

async function pessoas(cliente: string, perfil: string, busca: string) {
  const q = new URLSearchParams({ pagina: '1', tamanho_pagina: '50', tipo_ordenacao: 'NOME', ordem_ordenacao: 'ASC' });
  if (perfil) q.set('tipo_perfil', perfil);           // Cliente | Fornecedor
  if (busca) q.set('busca', busca);
  return itensDe(await ca(cliente, `/v1/pessoas?${q}`)).map((p: any) => ({ id: p.id, nome: p.nome, documento: p.documento }));
}

// ---------- baixa ----------
type Ajuste = { tipo: 'juros' | 'multa' | 'desconto'; valor: number } | null;
type Baixa = {
  fitid: string; parcela_id: string; tipo: string; data: string; valor: number;
  conta_financeira: string; metodo_pagamento?: string; historico?: string;
  comprovante?: { nome: string }; ajuste?: Ajuste; valor_parcela?: number;
};

const temAnexo = (parcela: any) =>
  (parcela?.anexos?.length ?? 0) > 0 ||
  (parcela?.baixas ?? []).some((b: any) => (b?.anexos?.length ?? 0) > 0);

// composição da baixa: valor da parcela + juros/multa − desconto = o que caiu no banco
function composicao(b: Baixa) {
  const aj = b.ajuste;
  if (!aj || !(aj.valor > 0)) return { valor_bruto: b.valor };
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const bruto = b.valor_parcela ?? r2(aj.tipo === 'desconto' ? b.valor + aj.valor : b.valor - aj.valor);
  return { valor_bruto: r2(bruto), [aj.tipo]: r2(aj.valor) };
}

async function registrarBaixa(cliente: string, b: Baixa) {
  const parcela = await ca(cliente, `/v1/financeiro/eventos-financeiros/parcelas/${b.parcela_id}`);
  // Observação: mantém o que já estiver escrito e acrescenta a marca da baixa automática.
  const obsAnterior = String(parcela?.nota ?? parcela?.observacao ?? '').trim(); // "nota" = observação da parcela na API v2
  const marca = `Baixa automática (conciliação bancária): ${b.historico ?? ''}`.trim().slice(0, 150);
  const body: Record<string, unknown> = {
    data_pagamento: b.data,
    composicao_valor: composicao(b),
    conta_financeira: b.conta_financeira,
    metodo_pagamento: b.metodo_pagamento || 'TRANSFERENCIA_BANCARIA',
    observacao: obsAnterior ? `${obsAnterior}\n${marca}` : marca,
  };
  if (parcela?.versao != null) body.versao = parcela.versao;
  const r = await ca(cliente, `/v1/financeiro/eventos-financeiros/parcelas/${b.parcela_id}/baixa`, {
    method: 'POST', body: JSON.stringify(body),
  });
  // comprovante: só identificado na tela (anexar à mão no Conta Azul)
  const anexo = b.comprovante ? 'manual' : temAnexo(parcela) ? 'ja_tinha' : 'falta';
  return { baixa_id: r?.id ?? null, anexo };
}

async function jaConciliado(cliente: string, fitid: string) {
  const { data } = await db.from('conciliacao_log').select('id').eq('cliente', cliente).eq('fitid', fitid).eq('status', 'ok').maybeSingle();
  return !!data;
}

const logRow = (cliente: string, b: Baixa) => ({
  cliente, fitid: b.fitid, parcela_id: b.parcela_id, tipo: b.tipo, data: b.data, valor: b.valor,
  conta_financeira: b.conta_financeira, historico: b.historico ?? null, ajuste: b.ajuste ?? null,
});

async function baixar(cliente: string, b: Baixa) {
  if (await jaConciliado(cliente, b.fitid)) return { fitid: b.fitid, status: 'ignorado', erro: 'Movimento já conciliado anteriormente' };
  try {
    const { baixa_id, anexo } = await registrarBaixa(cliente, b);
    await db.from('conciliacao_log').insert({ ...logRow(cliente, b), status: 'ok', baixa_id, anexo });
    return { fitid: b.fitid, status: 'ok', baixa_id, anexo };
  } catch (e) {
    const erro = String((e as Error).message ?? e);
    await db.from('conciliacao_log').insert({ ...logRow(cliente, b), status: 'erro', erro });
    return { fitid: b.fitid, status: 'erro', erro };
  }
}

// ---------- lançar a partir do extrato (tarifa, juros, IOF…) ----------
type Lancamento = {
  fitid: string; data: string; valor: number;            // valor com sinal do extrato
  historico?: string; descricao?: string;
  conta_financeira: string; metodo_pagamento?: string;
  id_categoria: string; id_contato: string;
};

async function lancar(cliente: string, l: Lancamento) {
  if (await jaConciliado(cliente, l.fitid)) return { fitid: l.fitid, status: 'ignorado', erro: 'Movimento já conciliado anteriormente' };
  const tipo = l.valor < 0 ? 'pagar' : 'receber';
  const valor = Math.round(Math.abs(l.valor) * 100) / 100;
  const base = { fitid: l.fitid, parcela_id: '', tipo, data: l.data, valor, conta_financeira: l.conta_financeira, historico: l.historico };
  let evento_id: string | null = null;
  try {
    const metodo = l.metodo_pagamento || 'TRANSFERENCIA_BANCARIA';
    const desc = (l.descricao || l.historico || 'Lançamento do extrato').slice(0, 200);
    const corpo: Record<string, unknown> = {
      descricao: desc,
      data_competencia: l.data,
      valor,
      conta_financeira: l.conta_financeira,
      observacao: `Lançado pela conciliação bancária: ${l.historico ?? ''}`.slice(0, 200),
      referencia_externa: `conciliacao:${l.fitid}`.slice(0, 100),
      rateio: [{ id_categoria: l.id_categoria, valor }],
      condicao_pagamento: { parcelas: [{
        descricao: desc, data_vencimento: l.data, conta_financeira: l.conta_financeira,
        metodo_pagamento: metodo, detalhe_valor: { valor_bruto: valor },
      }] },
    };
    corpo[tipo === 'pagar' ? 'id_fornecedor' : 'id_cliente'] = l.id_contato;
    const ev = await ca(cliente, `/v1/financeiro/contas-a-${tipo}`, { method: 'POST', body: JSON.stringify(corpo) });
    evento_id = ev?.id ?? null;
    const parcelaId = ev?.condicao_pagamento?.parcelas?.[0]?.id;
    if (!parcelaId) throw new Error('Lançamento criado, mas o Conta Azul não devolveu a parcela para dar baixa. Baixe à mão.');
    const b: Baixa = { ...base, parcela_id: parcelaId, metodo_pagamento: metodo };
    const { baixa_id } = await registrarBaixa(cliente, b);
    await db.from('conciliacao_log').insert({ ...logRow(cliente, b), registro: 'lancamento', evento_id, status: 'ok', baixa_id });
    return { fitid: l.fitid, status: 'ok', baixa_id, evento_id };
  } catch (e) {
    const erro = String((e as Error).message ?? e);
    await db.from('conciliacao_log').insert({ ...logRow(cliente, base as Baixa), registro: 'lancamento', evento_id, status: 'erro', erro });
    return { fitid: l.fitid, status: 'erro', erro, evento_id };
  }
}

// ---------- desfazer ----------
async function desfazer(cliente: string, fitid: string) {
  const { data: row } = await db.from('conciliacao_log').select('*')
    .eq('cliente', cliente).eq('fitid', fitid).eq('status', 'ok').maybeSingle();
  if (!row) throw new Error('Baixa não encontrada (já desfeita?).');
  if (!row.baixa_id) throw new Error('Esta baixa não tem identificador no Conta Azul; desfaça à mão.');
  await ca(cliente, `/v1/financeiro/eventos-financeiros/parcelas/baixa/${row.baixa_id}`, { method: 'DELETE' });
  await db.from('conciliacao_log').update({ status: 'desfeito', desfeito_em: new Date().toISOString() }).eq('id', row.id);
  return {
    fitid, status: 'desfeito',
    aviso: row.registro === 'lancamento'
      ? 'Baixa desfeita. O lançamento criado pelo robô continua no Conta Azul, em aberto — exclua-o lá se não for usar.'
      : 'Baixa desfeita: o lançamento voltou a ficar em aberto.',
  };
}

// ---------- boleto (PDF da cobrança) ----------
async function boletoPdf(cliente: string, parcelaId: string) {
  const parcela = await ca(cliente, `/v1/financeiro/eventos-financeiros/parcelas/${parcelaId}`);
  const ids = new Set<string>();
  for (const s of parcela?.solicitacoes_cobrancas ?? []) {
    for (const k of ['id_cobranca', 'id', 'id_solicitacao_cobranca']) if (typeof s?.[k] === 'string') ids.add(s[k]);
  }
  for (const k of ['id_ultimo_solicitacao_cobranca', 'id_ultima_solicitacao_cobranca', 'id_ultima_solicitacao_pagamento']) {
    if (typeof parcela?.[k] === 'string') ids.add(parcela[k]);
  }
  if (!ids.size) throw new Error('Este lançamento não tem cobrança (boleto) emitida no Conta Azul.');
  let ultimoErro = '';
  for (const id of ids) {
    const r = await caRaw(cliente, `/v1/financeiro/eventos-financeiros/contas-a-receber/cobranca/${id}/imprimir`,
      { headers: { Accept: 'application/pdf' } });
    if (r.ok) {
      const bytes = new Uint8Array(await r.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return { nome: `boleto_${(parcela?.descricao || parcelaId).replace(/[^\w.-]+/g, '_').slice(0, 60)}.pdf`, base64: btoa(bin) };
    }
    ultimoErro = `${r.status}: ${(await r.text()).slice(0, 200)}`;
  }
  throw new Error(`Não foi possível obter o PDF (só cobranças do tipo boleto têm PDF). Conta Azul ${ultimoErro}`);
}

// ---------- clientes ----------
async function listarClientes() {
  const { data, error } = await db.from('conta_azul_conexoes').select('cliente, nome, refresh_token, updated_at').order('nome');
  if (error) throw error;
  return (data ?? []).map((c) => ({ cliente: c.cliente, nome: c.nome, conectado: !!c.refresh_token, desde: c.updated_at }));
}

async function salvarCliente(p: { cliente?: string; nome?: string }) {
  const nome = String(p.nome ?? '').trim();
  if (!nome) throw new Error('Informe o nome do cliente.');
  if (p.cliente) {
    const { error } = await db.from('conta_azul_conexoes').update({ nome }).eq('cliente', p.cliente);
    if (error) throw error;
    return { cliente: p.cliente, nome };
  }
  let id = slug(nome) || 'cliente';
  for (let n = 2; n < 100; n++) {
    const { data } = await db.from('conta_azul_conexoes').select('cliente').eq('cliente', id).maybeSingle();
    if (!data) break;
    id = `${slug(nome)}-${n}`;
  }
  const { error } = await db.from('conta_azul_conexoes').insert({ cliente: id, nome });
  if (error) throw error;
  return { cliente: id, nome };
}

// ---------- roteamento ----------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);

  // retorno do login do Conta Azul (GET ?code=&state=)
  if (req.method === 'GET' && url.searchParams.has('code')) {
    const state = url.searchParams.get('state') ?? '';
    const { data } = await db.from('conta_azul_oauth_state').delete().eq('state', state).select().maybeSingle();
    if (!data || Date.now() - new Date(data.created_at).getTime() > 15 * 60_000) {
      return new Response('Estado inválido ou expirado. Tente conectar de novo.', { status: 400 });
    }
    try {
      await trocarToken(data.cliente, { grant_type: 'authorization_code', code: url.searchParams.get('code')!, redirect_uri: REDIRECT_URI });
    } catch (e) {
      return new Response(String((e as Error).message), { status: 500 });
    }
    const sep = APP_URL.includes('?') ? '&' : '?';
    return Response.redirect(`${APP_URL}${sep}conectado=1&cliente=${encodeURIComponent(data.cliente)}`, 302);
  }

  if (!ROBO_KEY || req.headers.get('x-robo-key') !== ROBO_KEY) return json({ erro: 'Chave do robô inválida' }, 401);

  try {
    const action = req.headers.get('x-action') ?? '';
    const cliente = req.headers.get('x-cliente') || 'principal';
    const p = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    switch (action) {
      case 'clientes':
        return json(await listarClientes());
      case 'cliente-salvar':
        return json(await salvarCliente(p));
      case 'auth-url': {
        const { data: c } = await db.from('conta_azul_conexoes').select('cliente').eq('cliente', cliente).maybeSingle();
        if (!c) throw new Error('Cliente não encontrado.');
        const state = crypto.randomUUID();
        await db.from('conta_azul_oauth_state').insert({ state, cliente });
        const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, state, scope: SCOPE });
        return json({ url: `${AUTH_URL}?${q}` });
      }
      case 'status': {
        const { data } = await db.from('conta_azul_conexoes').select('refresh_token, updated_at').eq('cliente', cliente).maybeSingle();
        return json({ conectado: !!data?.refresh_token, desde: data?.updated_at ?? null });
      }
      case 'contas-financeiras':
        return json(await contasFinanceiras(cliente));
      case 'parcelas': {
        const [receber, pagar] = await Promise.all([
          listarParcelas(cliente, 'receber', p.de, p.ate),
          listarParcelas(cliente, 'pagar', p.de, p.ate),
        ]);
        return json([...receber, ...pagar]);
      }
      case 'conciliados': {
        const { data } = await db.from('conciliacao_log').select('fitid').eq('cliente', cliente).eq('status', 'ok').in('fitid', p.fitids ?? []);
        return json((data ?? []).map((r) => r.fitid));
      }
      case 'categorias':
        return json(await categorias(cliente, p.tipo ?? ''));
      case 'pessoas':
        return json(await pessoas(cliente, p.perfil ?? '', p.busca ?? ''));
      case 'baixar': {
        const out = [];
        for (const b of (p.baixas ?? []) as Baixa[]) out.push(await baixar(cliente, b)); // sequencial: evita 429
        return json(out);
      }
      case 'lancar': {
        const out = [];
        for (const l of (p.lancamentos ?? []) as Lancamento[]) out.push(await lancar(cliente, l));
        return json(out);
      }
      case 'desfazer':
        return json(await desfazer(cliente, p.fitid));
      case 'historico': {
        const { data, error } = await db.from('conciliacao_log')
          .select('fitid, registro, tipo, data, valor, historico, status, erro, ajuste, anexo, created_at, desfeito_em')
          .eq('cliente', cliente).order('created_at', { ascending: false }).limit(Math.min(Number(p.limite) || 100, 500));
        if (error) throw error;
        return json(data ?? []);
      }
      case 'boleto-pdf':
        return json(await boletoPdf(cliente, p.parcela_id));
      default:
        return json({ erro: `Ação desconhecida: ${action}` }, 400);
    }
  } catch (e) {
    return json({ erro: String((e as Error).message ?? e) }, 500);
  }
});
