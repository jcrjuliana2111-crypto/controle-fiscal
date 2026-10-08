import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transporte = null;
export const caixaDeSaida = []; // usado em testes e em desenvolvimento sem SMTP

function obterTransporte() {
  if (!config.smtp) return null;
  if (!transporte) transporte = nodemailer.createTransport(config.smtp);
  return transporte;
}

const layout = (titulo, corpo, botao) => `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f4f5f8;padding:24px">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:10px;padding:28px;color:#1d2433">
<h2 style="margin-top:0">${titulo}</h2>${corpo}
${botao ? `<p style="margin:28px 0"><a href="${botao.url}" style="background:#4f7cff;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">${botao.texto}</a></p>
<p style="font-size:12px;color:#777">Se o botão não funcionar, copie este endereço: ${botao.url}</p>` : ''}
<p style="font-size:12px;color:#999;margin-top:28px">${config.nomeApp}</p></div></body></html>`;

export async function enviarEmail({ para, assunto, titulo, corpo, botao }) {
  const msg = { from: `${config.nomeApp} <${config.emailRemetente}>`, to: para, subject: assunto, html: layout(titulo, corpo, botao) };
  const t = obterTransporte();
  if (!t) {
    caixaDeSaida.push({ ...msg, link: botao?.url });
    if (caixaDeSaida.length > 50) caixaDeSaida.shift();
    if (!process.env.NODE_TEST_CONTEXT) console.log(`[email] (SMTP não configurado) para ${para}: ${assunto}${botao ? ' — ' + botao.url : ''}`);
    return;
  }
  await t.sendMail(msg);
}
