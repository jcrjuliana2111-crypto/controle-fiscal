import forge from 'node-forge';

/** Gera um certificado A1 autoassinado no formato ICP-Brasil (CN = "NOME:CNPJ") para testes. */
export function certificadoTeste({ cnpj = '11222333000181', senha = '1234', dias = 365 } = {}) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + dias * 86400000);
  const attrs = [{ name: 'commonName', value: `EMPRESA TESTE LTDA:${cnpj}` }, { name: 'countryName', value: 'BR' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], senha, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}
