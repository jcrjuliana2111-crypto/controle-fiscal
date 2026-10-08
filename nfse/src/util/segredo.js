import crypto from 'node:crypto';
import { config } from '../config.js';

// Criptografia simétrica (AES-256-GCM) para guardar o certificado e a senha em disco.
function chave() {
  return crypto.createHash('sha256').update(config.secret).digest();
}

export function cifrar(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave(), iv);
  const enc = Buffer.concat([c.update(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

export function decifrar(b64) {
  const raw = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', chave(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}
