#!/usr/bin/env node
// Mostra o que o robô de conciliação enxerga em cada comprovante de uma pasta:
// valores, vencimentos e datas de pagamento, lidos do nome do arquivo e — se o
// `pdftotext` (poppler) estiver instalado — do texto do PDF. Sem IA.
// Uso: node verificar_comprovantes.js "/caminho/da/pasta"
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('./conciliacao-core.js');

const pasta = process.argv[2];
if (!pasta || !fs.existsSync(pasta)) {
  console.error('Uso: node verificar_comprovantes.js "/caminho/da/pasta"');
  process.exit(1);
}

const EXT = /\.(pdf|png|jpe?g|webp)$/i;
function listar(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listar(p) : EXT.test(e.name) ? [p] : [];
  });
}

let temPdftotext = true;
function textoPdf(arq) {
  if (!temPdftotext) return '';
  try {
    return execFileSync('pdftotext', ['-l', '3', '-layout', arq, '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    if (e.code === 'ENOENT') temPdftotext = false;
    return '';
  }
}

const brl = c => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const br = d => d.split('-').reverse().join('/');
const arquivos = listar(pasta);
let semValor = 0;

for (const arq of arquivos) {
  const nome = path.basename(arq);
  const pdf = /\.pdf$/i.test(nome);
  const texto = pdf ? textoPdf(arq) : '';
  const d = C.dadosComprovante(texto, nome);
  const tipo = /favorecido|pix/i.test(d.texto) ? 'PIX' : /fornecedor|\bV\s*\d{6}\b|venc/i.test(d.texto) ? 'Fornecedor' : '?';
  const avisos = [];
  if (!d.valores.length) { semValor++; avisos.push('SEM VALOR — não será ligado automaticamente'); }
  if (d.valores.length > 1) avisos.push('mais de um valor: o robô aceita qualquer um deles');
  if (!pdf && !d.valores.length) avisos.push('imagem: coloque o valor no nome, ex. "FORNECEDOR X R$ 964,62 V 051026.jpg"');
  if (!d.datas.length && !d.vencimentos.length) avisos.push('sem data: depende de nome/descrição para desempatar');
  console.log(`\n${path.relative(pasta, arq)}`);
  console.log(`  tipo: ${tipo} | origem: ${pdf ? (texto.trim() ? 'nome + texto do PDF' : 'nome (PDF sem texto legível)') : 'nome (imagem)'}`);
  console.log(`  valores: ${d.valores.map(brl).join(', ') || '—'}`);
  console.log(`  vencimentos: ${d.vencimentos.map(br).join(', ') || '—'} | pagamentos: ${d.datas.map(br).join(', ') || '—'}`);
  for (const a of avisos) console.log(`  ⚠ ${a}`);
}

console.log(`\n${arquivos.length} comprovante(s), ${semValor} sem valor reconhecível.`);
if (!temPdftotext && arquivos.some(a => /\.pdf$/i.test(a))) {
  console.log('Obs.: pdftotext não encontrado — o texto dos PDFs não foi lido aqui (a tela do robô lê).');
}
