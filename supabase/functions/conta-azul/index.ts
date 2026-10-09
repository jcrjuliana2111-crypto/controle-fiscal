// Edge Function: ponte entre a página conciliacao.html e a API v2 do Conta Azul.
//
// Secrets (supabase secrets set ...):
//   CONTA_AZUL_CLIENT_ID, CONTA_AZUL_CLIENT_SECRET  – app do Portal do Desenvolvedor
//   CONTA_AZUL_REDIRECT_URI – URL desta função (…/functions/v1/conta-azul)
//   APP_URL                 – URL da página conciliacao.html (volta após o login)
//   ROBO_KEY                – senha que a página envia no header x-robo-key
//   CONTA_AZUL_ANEXO_PATH   – (opcional) rota da API para enviar anexo, ex.:
//                             /v1/financeiro/eventos-financeiros/parcelas/{parcela_id}/anexos
//                             Aceita {parcela_id} e {baixa_id}. Sem ela, o link do
//                             comprovante vai na observação da baixa.
//   CONTA_AZUL_ANEXO_CAMPO  – (opcional) nome do campo do arquivo no multipart (padrão "file")
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem em toda Edge Function.
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
const ANEXO_PATH = Deno.env.get('CONTA_AZUL_ANEXO_PATH') ?? '';
const ANEXO_CAMPO = Deno.env.get('CONTA_AZUL_ANEXO_CAMPO') ?? 'file';
const BUCKET = 'comprovantes';
const MAX_COMPROVANTE = 10 * 1024 * 1024;

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-action, x-robo-key, authorization, apikey',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ---------- tokens ----------
async function trocarToken(params: Record<string, string>) {
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
  const row = {
    id: 1,
    access_token: t.access_token,
    // o refresh pode não vir de novo na renovação — mantém o anterior
    ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
    expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000 - 60_000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { error } = await db.from('conta_azul_tokens').upsert(row);
  if (error) throw error;
  return row.access_token as string;
}

async function accessToken(): Promise<string> {
  const { data, error } = await db.from('conta_azul_tokens').select('*').eq('id', 1).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Conta Azul não conectado. Clique em "Conectar Conta Azul".');
  if (new Date(data.expires_at) > new Date()) return data.access_token;
  return trocarToken({ grant_type: 'refresh_token', refresh_token: data.refresh_token });
}

async function ca(path: string, init: RequestInit = {}) {
  const json = !(init.body instanceof FormData); // multipart: o fetch define o boundary
  const r = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(json ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
  });
  const txt = await r.text();
  const body = txt ? (() => { try { return JSON.parse(txt); } catch { return txt; } })() : null;
  if (!r.ok) throw new Error(`Conta Azul ${r.status} em ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}

// ---------- consultas ----------
async function listarParcelas(tipo: 'receber' | 'pagar', de: string, ate: string) {
  const out: unknown[] = [];
  for (let pagina = 1; pagina <= 50; pagina++) {
    const q = new URLSearchParams({
      pagina: String(pagina), tamanho_pagina: '100',
      data_vencimento_de: de, data_vencimento_ate: ate,
    });
    for (const s of ['EM_ABERTO', 'ATRASADO', 'RECEBIDO_PARCIAL']) q.append('status', s);
    const r = await ca(`/v1/financeiro/eventos-financeiros/contas-a-${tipo}/buscar?${q}`);
    const itens = r?.itens ?? r?.items ?? [];
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

async function contasFinanceiras() {
  const r = await ca('/v1/conta-financeira?pagina=1&tamanho_pagina=100&apenas_ativo=true');
  return (r?.itens ?? r?.items ?? r ?? []).map((c: any) => ({ id: c.id, nome: c.nome, banco: c.banco, tipo: c.tipo }));
}

type Comprovante = { path: string; url: string; nome: string };
type Baixa = {
  fitid: string; parcela_id: string; tipo: string; data: string; valor: number;
  conta_financeira: string; metodo_pagamento?: string; historico?: string;
  comprovante?: Comprovante;
};

// ---------- comprovantes ----------
async function salvarComprovante(p: { nome?: string; base64?: string; tipo?: string }) {
  if (!p.base64) throw new Error('Arquivo vazio');
  const bytes = Uint8Array.from(atob(p.base64), (c) => c.charCodeAt(0));
  if (bytes.length > MAX_COMPROVANTE) throw new Error('Comprovante maior que 10 MB');
  const nome = (p.nome || 'comprovante').normalize('NFD').replace(/[^\w.-]+/g, '_').slice(-80);
  const path = `${crypto.randomUUID()}/${nome}`;
  const { error } = await db.storage.from(BUCKET).upload(path, bytes, { contentType: p.tipo || 'application/octet-stream' });
  if (error) throw error;
  return { path, nome, url: db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl };
}

const temAnexo = (parcela: any) =>
  (parcela?.anexos?.length ?? 0) > 0 ||
  (parcela?.baixas ?? []).some((b: any) => (b?.anexos?.length ?? 0) > 0);

// envia o arquivo para o Conta Azul pela rota configurada em CONTA_AZUL_ANEXO_PATH
async function enviarAnexo(c: Comprovante, parcelaId: string, baixaId: string) {
  const { data, error } = await db.storage.from(BUCKET).download(c.path);
  if (error) throw error;
  const fd = new FormData();
  fd.append(ANEXO_CAMPO, data, c.nome);
  const path = ANEXO_PATH.replace('{parcela_id}', parcelaId).replace('{baixa_id}', baixaId ?? '');
  await ca(path, { method: 'POST', body: fd });
}

async function baixar(b: Baixa) {
  // trava contra baixa dupla do mesmo movimento do extrato
  const { data: ja } = await db.from('conciliacao_log').select('id').eq('fitid', b.fitid).eq('status', 'ok').maybeSingle();
  if (ja) return { fitid: b.fitid, status: 'ignorado', erro: 'Movimento já conciliado anteriormente' };

  try {
    const parcela = await ca(`/v1/financeiro/eventos-financeiros/parcelas/${b.parcela_id}`);
    // anexo: ja_tinha | anexado | link (na observação) | falta (sem comprovante) | erro
    let anexo = temAnexo(parcela) ? 'ja_tinha' : b.comprovante ? (ANEXO_PATH ? 'anexado' : 'link') : 'falta';
    let observacao = `Conciliação automática: ${b.historico ?? ''}`.slice(0, 120);
    if (anexo === 'link') observacao += ` | Comprovante: ${b.comprovante!.url}`;
    const body: Record<string, unknown> = {
      data_pagamento: b.data,
      composicao_valor: { valor_bruto: b.valor },
      conta_financeira: b.conta_financeira,
      metodo_pagamento: b.metodo_pagamento || 'TRANSFERENCIA_BANCARIA',
      observacao,
    };
    if (parcela?.versao != null) body.versao = parcela.versao;
    const r = await ca(`/v1/financeiro/eventos-financeiros/parcelas/${b.parcela_id}/baixa`, {
      method: 'POST', body: JSON.stringify(body),
    });
    let erroAnexo: string | undefined;
    if (anexo === 'anexado') {
      // a baixa já foi feita; falha no anexo não desfaz a baixa
      try { await enviarAnexo(b.comprovante!, b.parcela_id, r?.id); }
      catch (e) { anexo = 'erro'; erroAnexo = String((e as Error).message ?? e); }
    }
    await db.from('conciliacao_log').insert({
      ...logRow(b), status: 'ok', baixa_id: r?.id ?? null, anexo, erro: erroAnexo ?? null,
    });
    return { fitid: b.fitid, status: 'ok', baixa_id: r?.id, anexo, erro: erroAnexo };
  } catch (e) {
    const erro = String((e as Error).message ?? e);
    await db.from('conciliacao_log').insert({ ...logRow(b), status: 'erro', erro });
    return { fitid: b.fitid, status: 'erro', erro };
  }
}
const logRow = (b: Baixa) => ({
  fitid: b.fitid, parcela_id: b.parcela_id, tipo: b.tipo, data: b.data, valor: b.valor,
  conta_financeira: b.conta_financeira, historico: b.historico ?? null,
  comprovante_url: b.comprovante?.url ?? null,
});

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
      await trocarToken({ grant_type: 'authorization_code', code: url.searchParams.get('code')!, redirect_uri: REDIRECT_URI });
    } catch (e) {
      return new Response(String((e as Error).message), { status: 500 });
    }
    return Response.redirect(`${APP_URL}${APP_URL.includes('?') ? '&' : '?'}conectado=1`, 302);
  }

  if (!ROBO_KEY || req.headers.get('x-robo-key') !== ROBO_KEY) return json({ erro: 'Chave do robô inválida' }, 401);

  try {
    const action = req.headers.get('x-action') ?? '';
    const p = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    switch (action) {
      case 'auth-url': {
        const state = crypto.randomUUID();
        await db.from('conta_azul_oauth_state').insert({ state });
        const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, state, scope: SCOPE });
        return json({ url: `${AUTH_URL}?${q}` });
      }
      case 'status': {
        const { data } = await db.from('conta_azul_tokens').select('updated_at').eq('id', 1).maybeSingle();
        return json({ conectado: !!data, desde: data?.updated_at ?? null });
      }
      case 'contas-financeiras':
        return json(await contasFinanceiras());
      case 'parcelas': {
        const [receber, pagar] = await Promise.all([
          listarParcelas('receber', p.de, p.ate),
          listarParcelas('pagar', p.de, p.ate),
        ]);
        return json([...receber, ...pagar]);
      }
      case 'conciliados': {
        const { data } = await db.from('conciliacao_log').select('fitid').eq('status', 'ok').in('fitid', p.fitids ?? []);
        return json((data ?? []).map((r) => r.fitid));
      }
      case 'comprovante-upload':
        return json(await salvarComprovante(p));
      case 'baixar': {
        const out = [];
        for (const b of (p.baixas ?? []) as Baixa[]) out.push(await baixar(b)); // sequencial: evita 429
        return json(out);
      }
      default:
        return json({ erro: `Ação desconhecida: ${action}` }, 400);
    }
  } catch (e) {
    return json({ erro: String((e as Error).message ?? e) }, 500);
  }
});
