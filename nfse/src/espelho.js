import { esc } from './util/xml.js';

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDoc = (d = '') => d.length === 14
  ? d.replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, '$1.$2.$3/$4-$5')
  : d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');

/**
 * Espelho imprimível da nota (para provedores sem DANFSe oficial em PDF).
 * Não substitui o documento oficial disponível no portal da prefeitura.
 */
export function espelhoHtml(nota, prestador) {
  const t = nota.tomador || {};
  const c = nota.calculo || {};
  const cancelada = nota.status === 'cancelada';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>NFS-e ${esc(nota.numero || nota.numeroRps)}</title>
<style>
body{font:13px/1.4 system-ui,sans-serif;color:#111;background:#fff;max-width:820px;margin:24px auto;padding:0 16px}
h1{font-size:18px;margin:0}.box{border:1px solid #333;padding:10px 12px;margin-top:-1px}
.lbl{font-size:10px;text-transform:uppercase;color:#555;letter-spacing:.05em}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.tit{background:#eee;font-weight:600;font-size:11px;text-transform:uppercase;padding:4px 12px;border:1px solid #333;margin-top:-1px}
.cancel{position:fixed;top:40%;left:0;right:0;text-align:center;font-size:90px;color:rgba(200,0,0,.25);transform:rotate(-20deg);pointer-events:none}
pre{white-space:pre-wrap;font:inherit;margin:0}
@media print{button{display:none}body{margin:0}}
</style></head><body>
${cancelada ? '<div class="cancel">CANCELADA</div>' : ''}
<button onclick="print()">Imprimir</button>
<div class="box" style="margin-top:12px;display:flex;justify-content:space-between;gap:12px">
 <div><h1>NOTA FISCAL DE SERVIÇO ELETRÔNICA</h1><div>${esc(nota.municipio || '')} — ${nota.ambiente === 'producao' ? 'Produção' : '<b>HOMOLOGAÇÃO — SEM VALOR FISCAL</b>'}</div></div>
 <div style="text-align:right"><div class="lbl">Número</div><b style="font-size:20px">${esc(nota.numero || '—')}</b>
 <div class="lbl">Emissão</div>${esc((nota.dataAutorizacao || nota.criadoEm || '').slice(0, 19).replace('T', ' '))}</div>
</div>
<div class="box grid">
 <div><div class="lbl">Competência</div>${esc(nota.competencia || '')}</div>
 <div><div class="lbl">RPS/DPS</div>${esc(nota.serie)}/${esc(nota.numeroRps)}</div>
 <div style="grid-column:span 2"><div class="lbl">${nota.chaveAcesso ? 'Chave de acesso' : 'Código de verificação'}</div>${esc(nota.chaveAcesso || nota.codigoVerificacao || '—')}</div>
</div>
<div class="tit">Prestador</div>
<div class="box"><b>${esc(prestador?.razaoSocial || nota.prestadorNome || '')}</b><br>
CNPJ/CPF: ${esc(fmtDoc(prestador?.documento || ''))} · IM: ${esc(prestador?.inscricaoMunicipal || '')} · ${esc(prestador?.municipio || '')}/${esc(prestador?.uf || '')}</div>
<div class="tit">Tomador</div>
<div class="box">${t.tipo === 'NI' ? 'Tomador não identificado' : `<b>${esc(t.nome || '')}</b><br>
${t.tipo === 'EXT' ? 'NIF: ' + esc(t.nif || '—') : 'CNPJ/CPF: ' + esc(fmtDoc(t.documento || ''))}
${t.email ? ' · ' + esc(t.email) : ''}
${t.endereco?.logradouro ? `<br>${esc(t.endereco.logradouro)}, ${esc(t.endereco.numero || 'S/N')} ${esc(t.endereco.complemento || '')} — ${esc(t.endereco.bairro || '')} — CEP ${esc(t.endereco.cep || '')}` : ''}`}</div>
<div class="tit">Discriminação do serviço</div>
<div class="box"><pre>${esc(nota.servico?.discriminacao || '')}</pre>
<div style="margin-top:8px" class="lbl">Item LC 116: ${esc(nota.servico?.itemListaServico || '—')} · Cód. tributação nacional: ${esc(nota.servico?.codigoTributacaoNacional || '—')} · Cód. municipal: ${esc(nota.servico?.codigoTributacaoMunicipal || nota.servico?.codigoServicoMunicipal || '—')}</div></div>
<div class="tit">Valores</div>
<div class="box grid">
 <div><div class="lbl">Valor do serviço</div>${brl(c.valorServico)}</div>
 <div><div class="lbl">Deduções</div>${brl(c.deducoes)}</div>
 <div><div class="lbl">Desconto incond.</div>${brl(c.descontoIncondicionado)}</div>
 <div><div class="lbl">Base de cálculo</div>${brl(c.baseCalculo)}</div>
 <div><div class="lbl">Alíquota ISS</div>${Number(c.aliquotaIss || 0).toFixed(2)}%</div>
 <div><div class="lbl">Valor ISS</div>${brl(c.valorIss)}</div>
 <div><div class="lbl">ISS retido</div>${brl(c.valorIssRetido)}</div>
 <div><div class="lbl">Retenções federais</div>${brl(c.retencoesFederais)}</div>
 <div style="grid-column:span 4;text-align:right;font-size:16px"><span class="lbl">Valor líquido</span> <b>${brl(c.valorLiquido)}</b></div>
</div>
<p style="font-size:11px;color:#555">Espelho gerado pelo Controle Fiscal. O documento fiscal válido é o XML autorizado${nota.provedor === 'nacional' ? ' / DANFSe do Portal Nacional' : ' e a nota disponível no portal da prefeitura'}.</p>
</body></html>`;
}
