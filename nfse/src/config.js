import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const producao = env.NODE_ENV === 'production';

export const config = {
  raiz,
  producao,
  nomeApp: env.APP_NAME || 'EmitAI',
  urlApp: (env.APP_URL || `http://127.0.0.1:${env.PORT || 3333}`).replace(/\/$/, ''),
  porta: Number(env.PORT || 3333),
  host: env.HOST || (producao ? '0.0.0.0' : '127.0.0.1'),
  databaseUrl: env.DATABASE_URL || 'postgres://nfse:nfse@127.0.0.1:5432/nfse',
  // Chave mestra (32 bytes em base64) que cifra as chaves de dados dos certificados.
  chaveMestra: env.NFSE_MASTER_KEY || '',
  diasTeste: Number(env.TRIAL_DAYS || 14),
  smtp: env.SMTP_URL || '',          // ex.: smtps://usuario:senha@smtp.servidor.com:465
  emailRemetente: env.EMAIL_FROM || 'nao-responda@localhost',
  emailSuporte: env.SUPPORT_EMAIL || '',
  verAplic: 'EmitAI-2.0',
  asaas: {
    chave: env.ASAAS_API_KEY || '',
    ambiente: env.ASAAS_AMBIENTE === 'producao' ? 'producao' : 'sandbox',
    url: env.ASAAS_URL || (env.ASAAS_AMBIENTE === 'producao' ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3'),
    tokenWebhook: env.ASAAS_WEBHOOK_TOKEN || '',
    diasTolerancia: Number(env.DIAS_TOLERANCIA || 5),
  },
};

export function validarConfig() {
  const erros = [];
  if (producao && !config.chaveMestra) erros.push('NFSE_MASTER_KEY é obrigatória em produção.');
  if (config.chaveMestra && Buffer.from(config.chaveMestra, 'base64').length !== 32)
    erros.push('NFSE_MASTER_KEY deve ter 32 bytes em base64 (gere com: openssl rand -base64 32).');
  if (producao && !config.urlApp.startsWith('https://')) erros.push('APP_URL deve usar https:// em produção.');
  if (producao && !config.asaas.chave) console.warn('[nfse] AVISO: ASAAS_API_KEY não configurada — a assinatura online fica indisponível.');
  if (producao && !config.smtp) console.warn('[nfse] AVISO: SMTP_URL não configurada — e-mails de convite e senha não serão enviados.');
  if (erros.length) throw new Error('Configuração inválida:\n- ' + erros.join('\n- '));
}
