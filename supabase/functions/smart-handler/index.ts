import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-action',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const SUPA_URL = 'https://qftusjwnlyjokilcjuzb.supabase.co'
const ANON_KEY = Deno.env.get('ANON_KEY') ?? ''
const CLAUDE_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''

// Tabelas do controle de obrigações (painel obrigacoes.html e robô do Domínio)
const OBR_TABELAS: Record<string, string> = {
  empresas: 'obr_empresas',
  entregas: 'obr_entregas',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const action = req.headers.get('x-action') || ''

  if (action === 'claude') {
    const body = await req.json()
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    })
    return new Response(JSON.stringify(await r.json()), { headers: { ...cors, 'Content-Type': 'application/json' } })
  }

  if (action === 'get') {
    const r = await fetch(`${SUPA_URL}/rest/v1/notificacoes_fiscais?order=created_at.desc`, {
      headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}` }
    })
    return new Response(JSON.stringify(await r.json()), { headers: { ...cors, 'Content-Type': 'application/json' } })
  }

  if (action === 'upsert') {
    const body = await req.json()
    const r = await fetch(`${SUPA_URL}/rest/v1/notificacoes_fiscais`, {
      method: 'POST',
      headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(body),
    })
    return new Response(await r.text() || '{}', { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } })
  }

  if (action === 'delete') {
    const { id } = await req.json()
    const r = await fetch(`${SUPA_URL}/rest/v1/notificacoes_fiscais?id=eq.${id}`, {
      method: 'DELETE',
      headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}` }
    })
    return new Response('{}', { status: r.status, headers: cors })
  }

  if (action === 'upload-pdf') {
    const { id, filename, base64 } = await req.json()
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    const path = `${id}/${filename}`
    const r = await fetch(`${SUPA_URL}/storage/v1/object/notificacoes-pdf/${path}`, {
      method: 'POST',
      headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}`, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
      body: bytes,
    })
    if (!r.ok) return new Response(await r.text(), { status: r.status, headers: cors })
    const url = `${SUPA_URL}/storage/v1/object/public/notificacoes-pdf/${path}`
    return new Response(JSON.stringify({ url }), { headers: { ...cors, 'Content-Type': 'application/json' } })
  }

  // ---------------------------------------------------------------- obrigações
  if (action === 'obr-get' || action === 'obr-upsert' || action === 'obr-delete') {
    const body = await req.json().catch(() => ({}))
    const tabela = OBR_TABELAS[body.tabela]
    if (!tabela) return json({ error: 'tabela inválida' }, 400)
    const auth = { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}` }

    if (action === 'obr-get') {
      let url = `${SUPA_URL}/rest/v1/${tabela}?order=id&limit=10000`
      if (body.tabela === 'entregas' && body.competencia) url += `&competencia=eq.${encodeURIComponent(body.competencia)}`
      if (body.tabela === 'entregas' && body.empresa_id) url += `&empresa_id=eq.${encodeURIComponent(body.empresa_id)}`
      const r = await fetch(url, { headers: auth })
      return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    if (action === 'obr-upsert') {
      const rows: Record<string, unknown>[] = Array.isArray(body.rows) ? body.rows : []
      if (!rows.length) return json({ ok: true, gravados: 0 })
      // PostgREST exige as mesmas colunas em todas as linhas de um upsert em lote
      const grupos = new Map<string, Record<string, unknown>[]>()
      for (const row of rows) {
        const chave = Object.keys(row).sort().join(',')
        grupos.set(chave, [...(grupos.get(chave) ?? []), row])
      }
      for (const lote of grupos.values()) {
        const r = await fetch(`${SUPA_URL}/rest/v1/${tabela}?on_conflict=id`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(lote),
        })
        if (!r.ok) return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } })
      }
      return json({ ok: true, gravados: rows.length })
    }

    // obr-delete
    if (!body.id) return json({ error: 'id obrigatório' }, 400)
    const r = await fetch(`${SUPA_URL}/rest/v1/${tabela}?id=eq.${encodeURIComponent(body.id)}`, {
      method: 'DELETE', headers: auth,
    })
    if (!r.ok) return new Response(await r.text(), { status: r.status, headers: cors })
    return json({ ok: true })
  }

  return new Response('not found', { status: 404, headers: cors })
})
