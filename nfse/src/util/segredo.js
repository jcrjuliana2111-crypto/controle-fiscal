import crypto from 'node:crypto';
import { config } from '../config.js';

// Criptografia em envelope: cada certificado é cifrado com uma chave de dados
// (DEK) aleatória, e a DEK é cifrada com a chave mestra (NFSE_MASTER_KEY).
// Para usar um KMS (AWS/GCP), basta trocar cifrarChave/decifrarChave.

const DEV_KEY = crypto.createHash('sha256').update('chave-de-desenvolvimento-nao-use-em-producao').digest();

function chaveMestra() {
  return config.chaveMestra ? Buffer.from(config.chaveMestra, 'base64') : DEV_KEY;
}

export function cifrar(dado, chave) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave, iv);
  const enc = Buffer.concat([c.update(Buffer.isBuffer(dado) ? dado : Buffer.from(String(dado), 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

export function decifrar(b64, chave) {
  const raw = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', chave, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

export function novaChaveDados() {
  const dek = crypto.randomBytes(32);
  return { dek, dekCifrada: cifrar(dek, chaveMestra()) };
}

export function abrirChaveDados(dekCifrada) {
  return decifrar(dekCifrada, chaveMestra());
}

/** Token aleatório para URLs/cookies e seu hash (só o hash vai para o banco). */
export function novoToken(prefixo = '', bytes = 32) {
  const token = prefixo + crypto.randomBytes(bytes).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

const scrypt = (senha, sal) => new Promise((ok, erro) =>
  crypto.scrypt(senha, sal, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? erro(e) : ok(k))));

export async function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  return `scrypt$${sal.toString('base64')}$${(await scrypt(senha, sal)).toString('base64')}`;
}

export async function conferirSenha(senha, hash) {
  const [alg, sal, k] = String(hash || '').split('$');
  if (alg !== 'scrypt') return false;
  const calc = await scrypt(String(senha), Buffer.from(sal, 'base64'));
  const esperado = Buffer.from(k, 'base64');
  return calc.length === esperado.length && crypto.timingSafeEqual(calc, esperado);
}
