import https from 'node:https';
import http from 'node:http';

/**
 * Requisição HTTP(S) com autenticação mútua TLS usando o certificado A1
 * (chave e certificado em PEM). Retorna { status, headers, body: Buffer }.
 */
export function request(url, { method = 'GET', headers = {}, body, key, cert, timeout = 60000 } = {}) {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const opts = {
    method,
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    headers: { ...headers },
    timeout,
  };
  if (payload) opts.headers['Content-Length'] = payload.length;
  if (isHttps && key && cert) {
    opts.key = key;
    opts.cert = cert;
  }
  const lib = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error(`Tempo esgotado ao acessar ${u.host}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Envelopa e envia uma chamada SOAP 1.1 ou 1.2. */
export async function soap(url, { action, body, version = '1.1', key, cert, extraNs = '' }) {
  const envNs = version === '1.2'
    ? 'http://www.w3.org/2003/05/soap-envelope'
    : 'http://schemas.xmlsoap.org/soap/envelope/';
  const envelope = `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="${envNs}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xmlns:xsd="http://www.w3.org/2001/XMLSchema"${extraNs ? ' ' + extraNs : ''}>` +
    `<soap:Body>${body}</soap:Body></soap:Envelope>`;
  const headers = version === '1.2'
    ? { 'Content-Type': `application/soap+xml; charset=utf-8${action ? `; action="${action}"` : ''}` }
    : { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${action || ''}"` };
  const res = await request(url, { method: 'POST', headers, body: envelope, key, cert });
  return { ...res, text: res.body.toString('utf8'), envelope };
}
