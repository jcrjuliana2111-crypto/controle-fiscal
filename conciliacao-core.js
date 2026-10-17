// Motor de conciliação bancária: lê extrato (OFX/CSV) e casa cada
// movimento com uma parcela em aberto do Conta Azul.
// Funções puras — usadas pela página conciliacao.html e pelos testes.
(function (root) {
  'use strict';

  // --- utilitários ---
  function parseValorBR(s) {
    if (typeof s === 'number') return s;
    s = String(s || '').trim().replace(/[R$\s]/g, '');
    if (!s) return NaN;
    const neg = /^\(.*\)$/.test(s) || /-$/.test(s) || /D$/i.test(s);
    s = s.replace(/[()]/g, '').replace(/[-+]$/, '').replace(/[CD]$/i, '');
    // "1.234,56" → 1234.56 ; "1234.56" → 1234.56
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const v = parseFloat(s);
    return neg ? -Math.abs(v) : v;
  }

  function parseData(s) {
    s = String(s || '').trim();
    let m = s.match(/^(\d{4})(\d{2})(\d{2})/); // OFX 20260131...
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) {
      const y = m[3].length === 2 ? '20' + m[3] : m[3];
      return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    return '';
  }

  function diasEntre(a, b) {
    return Math.round(Math.abs(new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);
  }

  const STOP = new Set(['de', 'da', 'do', 'dos', 'das', 'e', 'ltda', 'me', 'epp', 'sa', 'eireli',
    'pix', 'ted', 'doc', 'transf', 'transferencia', 'pagamento', 'pagto', 'pgto', 'recebido',
    'enviado', 'boleto', 'tit', 'titulo', 'cobranca', 'liquidacao', 'credito', 'debito', 'conta']);

  function tokens(s) {
    return String(s || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/).filter(t => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
  }

  // fração dos tokens do nome do contato que aparecem no histórico do banco
  function similaridadeNome(historico, nome) {
    const tn = tokens(nome);
    if (!tn.length) return 0;
    const th = new Set(tokens(historico));
    return tn.filter(t => th.has(t)).length / tn.length;
  }

  // --- leitura de extratos ---
  function parseOFX(texto) {
    const out = [];
    const blocos = String(texto).split(/<STMTTRN>/i).slice(1);
    for (const b of blocos) {
      const tag = n => {
        const m = b.match(new RegExp('<' + n + '>([^<\\r\\n]*)', 'i'));
        return m ? m[1].trim() : '';
      };
      const valor = parseValorBR(tag('TRNAMT').replace(',', '.'));
      const data = parseData(tag('DTPOSTED'));
      if (!data || isNaN(valor)) continue;
      out.push({
        id: tag('FITID') || `${data}|${valor}|${out.length}`,
        data, valor,
        historico: [tag('NAME'), tag('MEMO')].filter(Boolean).join(' ')
      });
    }
    return out;
  }

  function splitCSVLinha(linha, sep) {
    const cols = []; let cur = ''; let q = false;
    for (let i = 0; i < linha.length; i++) {
      const c = linha[i];
      if (c === '"') { if (q && linha[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === sep && !q) { cols.push(cur); cur = ''; }
      else cur += c;
    }
    cols.push(cur);
    return cols.map(s => s.trim());
  }

  // CSV com cabeçalho contendo colunas de data, valor e histórico/descrição.
  // Aceita também colunas separadas de crédito e débito.
  function parseCSV(texto) {
    const linhas = String(texto).replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
    if (!linhas.length) return [];
    const sep = (linhas[0].match(/;/g) || []).length >= (linhas[0].match(/,/g) || []).length ? ';' : ',';
    const head = splitCSVLinha(linhas[0], sep).map(h =>
      h.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim());
    const idx = re => head.findIndex(h => re.test(h));
    const iData = idx(/data/);
    const iValor = idx(/^valor|valor$|^montante|^quantia/);
    const iCred = idx(/credito|entrada/);
    const iDeb = idx(/debito|saida/);
    const iHist = idx(/hist|descr|memo|lancamento|detalhe/);
    const iDoc = idx(/^doc|documento|^id$|identificador/);
    if (iData < 0 || (iValor < 0 && iCred < 0 && iDeb < 0)) {
      throw new Error('CSV precisa de colunas "Data" e "Valor" (ou "Crédito"/"Débito").');
    }
    const out = [];
    for (let n = 1; n < linhas.length; n++) {
      const c = splitCSVLinha(linhas[n], sep);
      const data = parseData(c[iData]);
      let valor;
      if (iValor >= 0) valor = parseValorBR(c[iValor]);
      else {
        const cr = parseValorBR(c[iCred]); const db = parseValorBR(c[iDeb]);
        valor = (!isNaN(cr) && cr) ? Math.abs(cr) : -Math.abs(db);
      }
      if (!data || isNaN(valor) || valor === 0) continue;
      out.push({
        id: (iDoc >= 0 && c[iDoc]) ? c[iDoc] : `${data}|${valor}|${n}`,
        data, valor,
        historico: iHist >= 0 ? c[iHist] : ''
      });
    }
    return out;
  }

  function parseExtrato(nomeArquivo, texto) {
    if (/\.ofx$/i.test(nomeArquivo) || /<OFX>/i.test(texto)) return parseOFX(texto);
    return parseCSV(texto);
  }

  // --- conciliação ---
  // Nome do favorecido/pagador quando o histórico é de PIX/TED/DOC/transferência
  // ("PIX ( DOC.: DEB PIX / ROGERIO LIMA DOS SANTOS )", "TED BETA SERVICOS").
  // Boletos, tarifas e débitos automáticos não trazem nome confiável → ''.
  const GENERICO = new Set(['deb', 'cred', 'env', 'rec', 'recebida', 'enviada', 'instantaneo', 'ib',
    'agendado', 'agend', 'mesma', 'titularidade', 'outra', 'outras', 'banco', 'agencia', 'qrcode', 'chave']);
  function nomeNoExtrato(historico) {
    const h = String(historico || '');
    if (!/\b(pix|ted|transf\w*|doc)\b/i.test(h)) return '';
    if (/liquida[cç]|t[ií]tulo|boleto|bloqueto|tarifa|\biof\b|juros|cesta|convenio|conv[eê]nio/i.test(h)) return '';
    const trecho = h.includes('/') ? h.slice(h.lastIndexOf('/') + 1) : h;
    const t = tokens(trecho).filter(x => !GENERICO.has(x));
    return t.length >= 2 ? t.join(' ') : '';
  }

  // nome do extrato bate com o contato (ou com a descrição) do lançamento?
  function nomeBate(nomeExtrato, parcela) {
    const sim = (a, b) => Math.max(similaridadeNome(a, b), similaridadeNome(b, a));
    return Math.max(sim(nomeExtrato, parcela.nome), sim(nomeExtrato, parcela.descricao)) >= 0.5;
  }

  // diferença entre o que caiu no banco e o valor da parcela:
  // a maior → juros (ou multa); a menor → desconto.
  function ajusteDe(movimento, parcela) {
    const dif = Math.round(Math.abs(movimento.valor) * 100) - Math.round(parcela.valor * 100);
    if (!dif) return null;
    return { tipo: dif > 0 ? 'juros' : 'desconto', valor: Math.abs(dif) / 100 };
  }

  // monta um par escolhido à mão na tela
  function montarPar(movimento, parcela) {
    return { movimento, parcela, dias: diasEntre(movimento.data, parcela.vencimento), similaridade: 0,
      score: 0, confianca: 'manual', ajuste: ajusteDe(movimento, parcela) };
  }

  // movimentos: [{id, data, valor(+ entrada / - saída), historico}]
  // parcelas:   [{id, tipo:'receber'|'pagar', vencimento, valor, nome, descricao}]
  // Regras:
  //  1. valor igual (centavos), tipo compatível com o sinal e vencimento até
  //     `janelaDias` de distância;
  //  2. se o histórico traz nome (PIX/TED/DOC), ele PRECISA bater com o contato ou
  //     a descrição — senão vira só "possível" em semParcela, para vincular à mão;
  //  3. sem casamento exato: mesmo contato (nome ≥ 50%), diferença de até
  //     `margemAjuste` (15%) e até `janelaAjuste` (30) dias → sugestão com juros/desconto.
  // Cada parcela casa com no máximo um movimento.
  function conciliar(movimentos, parcelas, opts) {
    const janela = (opts && opts.janelaDias) != null ? opts.janelaDias : 5;
    const margem = (opts && opts.margemAjuste) != null ? opts.margemAjuste : 0.15;
    const janelaAjuste = Math.max(janela, (opts && opts.janelaAjuste) != null ? opts.janelaAjuste : 30);
    const cand = [], possiveis = {};
    for (const m of movimentos) {
      const tipo = m.valor > 0 ? 'receber' : 'pagar';
      const cents = Math.round(Math.abs(m.valor) * 100);
      const nomeExt = nomeNoExtrato(m.historico);
      for (const p of parcelas) {
        if (p.tipo !== tipo || Math.round(p.valor * 100) !== cents) continue;
        const dias = diasEntre(m.data, p.vencimento);
        if (dias > janela) continue;
        if (nomeExt && !nomeBate(nomeExt, p)) {
          (possiveis[m.id] = possiveis[m.id] || []).push({ parcela: p, dias, motivo: 'nome diferente' });
          continue;
        }
        const nome = Math.max(similaridadeNome(m.historico, p.nome), similaridadeNome(m.historico, p.descricao) * 0.8,
          nomeExt ? 1 : 0);
        const score = 60 + 20 * (1 - dias / (janela + 1)) + 20 * nome;
        cand.push({ m, p, dias, nome, score, nomeExt: !!nomeExt });
      }
    }
    cand.sort((a, b) => b.score - a.score);

    // quantos candidatos cada movimento/parcela tem (para medir ambiguidade)
    const nM = {}, nP = {};
    for (const c of cand) { nM[c.m.id] = (nM[c.m.id] || 0) + 1; nP[c.p.id] = (nP[c.p.id] || 0) + 1; }

    const usadosM = new Set(), usadosP = new Set(), pares = [];
    for (const c of cand) {
      if (usadosM.has(c.m.id) || usadosP.has(c.p.id)) continue;
      usadosM.add(c.m.id); usadosP.add(c.p.id);
      const unico = nM[c.m.id] === 1 && nP[c.p.id] === 1;
      // alta só com nome batendo; sem nome no extrato (boleto etc.) fica média para conferir
      let confianca = 'baixa';
      if (c.nome >= 0.5 && c.dias <= 3) confianca = 'alta';
      else if (c.nome >= 0.5 || (unico && c.dias <= 3)) confianca = 'media';
      pares.push({
        movimento: c.m, parcela: c.p, dias: c.dias,
        similaridade: Math.round(c.nome * 100) / 100,
        score: Math.round(c.score), confianca, ajuste: null
      });
    }

    // 3. juros / multa / desconto: mesmo contato, valor um pouco diferente
    const candAj = [];
    for (const m of movimentos) {
      if (usadosM.has(m.id)) continue;
      const tipo = m.valor > 0 ? 'receber' : 'pagar';
      const nomeExt = nomeNoExtrato(m.historico);
      for (const p of parcelas) {
        if (usadosP.has(p.id) || p.tipo !== tipo || !(p.valor > 0)) continue;
        const aj = ajusteDe(m, p);
        if (!aj || aj.valor > p.valor * margem) continue;
        const dias = diasEntre(m.data, p.vencimento);
        if (dias > janelaAjuste) continue;
        const nome = nomeExt ? (nomeBate(nomeExt, p) ? 1 : 0)
          : Math.max(similaridadeNome(m.historico, p.nome), similaridadeNome(m.historico, p.descricao) * 0.8);
        if (nome < 0.5) continue;
        candAj.push({ m, p, dias, nome, aj, score: nome * 50 - dias - 100 * aj.valor / p.valor });
      }
    }
    candAj.sort((a, b) => b.score - a.score);
    for (const c of candAj) {
      if (usadosM.has(c.m.id) || usadosP.has(c.p.id)) continue;
      usadosM.add(c.m.id); usadosP.add(c.p.id);
      pares.push({ movimento: c.m, parcela: c.p, dias: c.dias, similaridade: Math.round(c.nome * 100) / 100,
        score: Math.round(c.score), confianca: 'media', ajuste: c.aj });
    }

    return {
      pares,
      semParcela: movimentos.filter(m => !usadosM.has(m.id))
        .map(m => possiveis[m.id] ? { ...m, possiveis: possiveis[m.id].filter(x => !usadosP.has(x.parcela.id)) } : m),
      parcelasSemMovimento: parcelas.filter(p => !usadosP.has(p.id))
    };
  }

  // Depois de ligar os comprovantes: se o comprovante traz o nome do contato,
  // a sugestão de confiança média (sem nome no extrato) sobe para alta.
  function reforcarComComprovantes(pares, vinculo, comprovantes) {
    const porId = Object.fromEntries(comprovantes.map(c => [c.id, c]));
    const subiram = [];
    for (const p of pares) {
      const c = porId[vinculo[p.movimento.id]];
      if (!c || p.confianca !== 'media' || p.ajuste || p.dias > 3) continue;
      if (similaridadeNome(c.texto, p.parcela.nome) >= 0.5) { p.confianca = 'alta'; subiram.push(p.movimento.id); }
    }
    return subiram;
  }

  // Extrai valores e datas de um comprovante sem IA: usa o texto do PDF
  // (quando houver) e o nome do arquivo. Formatos usados no escritório:
  //   PIX:        FAVORECIDO: NOME / VALOR R$ 490,00 / TIPO: PIX ENVIADO / DESCRIÇÃO (igual ao Conta Azul)
  //   Fornecedor: FORNECEDOR: NOME / VALOR: R$ 964,62 / VENCIMENTO: V 051026  (ddmmaa)
  // `vencimentos` são datas de vencimento (comparadas com o vencimento da
  // parcela); `datas` são datas de pagamento (comparadas com a data do banco).
  function dadosComprovante(texto, nomeArquivo) {
    const nome = String(nomeArquivo || '').replace(/\.[a-z0-9]+$/i, '');
    const fontes = [String(texto || ''), nome];
    const valores = new Set(), datas = new Set(), vencimentos = new Set();
    for (const f of fontes) {
      for (const m of f.matchAll(/(\d{1,3}(?:\.\d{3})+,\d{2}|\d+,\d{2})(?!\d)/g)) valores.add(Math.round(parseValorBR(m[1]) * 100));
      // "V 051026", "V051026", "VENCIMENTO: V 05/10/26"
      for (const m of f.matchAll(/(?<![a-z])V\s*\.?\s*(\d{2})[/.-]?(\d{2})[/.-]?(\d{2}|\d{4})(?!\d)/gi)) {
        const d = parseData(`${m[1]}/${m[2]}/${m[3]}`); if (valido(d)) vencimentos.add(d);
      }
      // "Vencimento: 05/10/2026" / "Data de vencimento 05.10.26"
      for (const m of f.matchAll(/venc(?:imento)?[^\d\n]{0,15}(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)/gi)) {
        const d = parseData(`${m[1]}/${m[2]}/${m[3]}`); if (valido(d)) vencimentos.add(d);
      }
      const semVenc = f
        .replace(/venc(?:imento)?[^\d\n]{0,15}\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}(?!\d)/gi, ' ')
        .replace(/(?<![a-z])V\s*\.?\s*\d{2}[/.-]?\d{2}[/.-]?\d{2,4}(?!\d)/gi, ' ');
      for (const m of semVenc.matchAll(/(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\d/])/g)) {
        const d = parseData(`${m[1]}/${m[2]}/${m[3]}`); if (valido(d)) datas.add(d);
      }
      for (const m of semVenc.matchAll(/(?<!\d)(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?!\d)/g)) {
        const d = `${m[1]}-${m[2]}-${m[3]}`; if (valido(d)) datas.add(d);
      }
    }
    // no nome do arquivo aceita também ponto decimal: "ENEL 320.40.pdf"
    for (const m of nome.matchAll(/(?<![\d.])(\d+)[.](\d{2})(?![\d.])/g)) valores.add(Number(m[1]) * 100 + Number(m[2]));
    return {
      valores: [...valores].filter(v => v > 0), datas: [...datas], vencimentos: [...vencimentos],
      texto: fontes.join(' ')
    };
  }
  function valido(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    return !!m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31 && +m[1] >= 2000;
  }

  // Liga comprovantes ({id, valores:[centavos], datas, vencimentos, texto}) às
  // sugestões de baixa. Regras:
  //  - o valor do movimento precisa estar entre os valores do comprovante;
  //  - se o comprovante tem vencimento, ele deve bater com o da parcela (±janela);
  //    se tem data de pagamento, ela deve estar a ±janela da data do banco;
  //  - nome (favorecido/fornecedor) e descrição iguais à do Conta Azul pontuam;
  //  - comprovante sem data e sem nome/descrição batendo só é aceito quando
  //    não há outra opção com o mesmo valor (evita trocar folhas de mesmo valor).
  // Retorna { idMovimento: idComprovante }.
  function casarComprovantes(pares, comprovantes, opts) {
    const janela = (opts && opts.janelaDias) != null ? opts.janelaDias : 3;
    const cand = [];
    for (const par of pares) {
      const cents = Math.round(Math.abs(par.movimento.valor) * 100);
      for (const c of comprovantes) {
        if (!c.valores.includes(cents)) continue;
        const venc = c.vencimentos || [];
        let dias = null;
        if (venc.length) {
          if (!par.parcela.vencimento) continue;
          dias = Math.min(...venc.map(d => diasEntre(par.parcela.vencimento, d)));
          if (dias > janela) continue;
        }
        if (c.datas.length) {
          const dp = Math.min(...c.datas.map(d => diasEntre(par.movimento.data, d)));
          if (dp > janela && !venc.length) continue;
          if (dp <= janela) dias = dias == null ? dp : Math.min(dias, dp);
        }
        const nome = similaridadeNome(c.texto, par.parcela.nome);
        const desc = similaridadeNome(c.texto, par.parcela.descricao);
        cand.push({ m: par.movimento.id, c: c.id, semData: dias == null, fraco: dias == null && nome < 0.5 && desc < 0.5,
          score: 10 * nome + 10 * desc - (dias == null ? janela + 1 : dias) });
      }
    }
    const nM = {}, nC = {};
    for (const x of cand) { nM[x.m] = (nM[x.m] || 0) + 1; nC[x.c] = (nC[x.c] || 0) + 1; }
    cand.sort((a, b) => b.score - a.score);
    const usadosM = new Set(), usadosC = new Set(), out = {};
    for (const x of cand) {
      if (usadosM.has(x.m) || usadosC.has(x.c)) continue;
      if (x.fraco && (nM[x.m] > 1 || nC[x.c] > 1)) continue;
      usadosM.add(x.m); usadosC.add(x.c); out[x.m] = x.c;
    }
    return out;
  }

  // Resumo do fechamento em texto, para enviar ao cliente.
  // d = { cliente, conta, de, ate, movimentos, resultado, retornos, lancados, hoje }
  function resumoFechamento(d) {
    const brl = v => (v < 0 ? '-' : '') + 'R$ ' + Math.abs(Number(v)).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const dt = s => s ? s.split('-').reverse().join('/') : '';
    const soma = l => l.reduce((s, x) => s + Math.abs(x), 0);
    const r = d.resultado, ret = d.retornos || {};
    const baixados = r.pares.filter(p => ret[p.movimento.id]?.status === 'ok');
    const lancados = d.lancados || [];
    const lancIds = new Set(lancados.map(x => x.movimento.id));
    const pend = r.semParcela.filter(m => !lancIds.has(m.id));
    const sugAbertas = r.pares.filter(p => ret[p.movimento.id]?.status !== 'ok');
    const hoje = d.hoje || new Date().toISOString().slice(0, 10);
    const atrasados = r.parcelasSemMovimento.filter(p => p.vencimento && p.vencimento < hoje);
    const L = [];
    L.push(`RESUMO DA CONCILIAÇÃO BANCÁRIA${d.cliente ? ' — ' + d.cliente : ''}`);
    if (d.conta) L.push(`Conta: ${d.conta}`);
    L.push(`Período do extrato: ${dt(d.de)} a ${dt(d.ate)}`);
    L.push('');
    L.push(`Movimentos no extrato: ${d.movimentos.length} (entradas ${brl(soma(d.movimentos.filter(m => m.valor > 0).map(m => m.valor)))}, saídas ${brl(soma(d.movimentos.filter(m => m.valor < 0).map(m => m.valor)))})`);
    L.push(`Baixados no Conta Azul: ${baixados.length} (${brl(soma(baixados.map(p => p.movimento.valor)))})`);
    const comAj = baixados.filter(p => p.ajuste);
    if (comAj.length) L.push(`  dos quais com juros/multa/desconto: ${comAj.length}`);
    if (lancados.length) L.push(`Lançados a partir do extrato (tarifas, juros etc.): ${lancados.length} (${brl(soma(lancados.map(x => x.movimento.valor)))})`);
    if (sugAbertas.length) L.push(`Sugestões ainda não baixadas: ${sugAbertas.length} (${brl(soma(sugAbertas.map(p => p.movimento.valor)))})`);
    L.push('');
    L.push(`PENDÊNCIAS — movimentos do banco sem lançamento: ${pend.length} (${brl(soma(pend.map(m => m.valor)))})`);
    for (const m of pend) L.push(`  ${dt(m.data)}  ${brl(m.valor).padStart(14)}  ${(m.valor < 0 ? 'saída ' : 'entrada')}  ${m.historico}`);
    L.push('');
    L.push(`LANÇAMENTOS EM ABERTO SEM MOVIMENTO NO BANCO: ${r.parcelasSemMovimento.length}`);
    if (atrasados.length) {
      L.push(`  Vencidos (antes de ${dt(hoje)}): ${atrasados.length} (${brl(soma(atrasados.map(p => p.valor)))})`);
      for (const p of atrasados) L.push(`  ${dt(p.vencimento)}  ${brl(p.valor).padStart(14)}  ${p.tipo === 'receber' ? 'a receber' : 'a pagar  '}  ${p.nome || ''}${p.descricao ? ' — ' + p.descricao : ''}`);
    }
    return L.join('\n');
  }

  const api = { parseValorBR, parseData, parseOFX, parseCSV, parseExtrato, similaridadeNome, conciliar, dadosComprovante, casarComprovantes,
    nomeNoExtrato, nomeBate, ajusteDe, montarPar, reforcarComComprovantes, resumoFechamento };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Conciliacao = api;
})(this);
