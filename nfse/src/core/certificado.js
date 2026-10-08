import forge from 'node-forge';

/**
 * Lê um certificado A1 (PKCS#12 / .pfx) e devolve chave e certificado em PEM.
 * Usamos PEM (e não o PFX direto) no TLS porque muitos .pfx emitidos por AC
 * brasileiras usam algoritmos legados (RC2/3DES) que o OpenSSL 3 recusa.
 */
export function lerCertificado(pfx, senha) {
  let p12;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, senha);
  } catch (e) {
    throw new Error('Não foi possível abrir o certificado: senha incorreta ou arquivo inválido.');
  }

  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
  ];
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  if (!keyBags.length || !certBags.length) throw new Error('Certificado sem chave privada ou sem certificado.');

  const key = keyBags[0].key;
  // Escolhe o certificado cuja chave pública corresponde à chave privada (o "folha").
  const folha = certBags.map((b) => b.cert).find((c) =>
    c.publicKey.n && key.n && c.publicKey.n.equals(key.n)) || certBags[0].cert;
  const cadeia = certBags.map((b) => b.cert).filter((c) => c !== folha);

  const certPem = forge.pki.certificateToPem(folha);
  const cn = folha.subject.getField('CN')?.value || '';
  // e-CNPJ ICP-Brasil: CN = "RAZAO SOCIAL:12345678000199"; e-CPF: "NOME:12345678901"
  const docCn = (cn.split(':')[1] || '').replace(/[^0-9A-Z]/gi, '');
  const docSan = documentoDoSAN(folha);

  return {
    keyPem: forge.pki.privateKeyToPem(key),
    certPem,
    cadeiaPem: cadeia.map((c) => forge.pki.certificateToPem(c)),
    certB64: certPem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, ''),
    titular: cn.split(':')[0] || cn,
    documento: docSan || docCn,
    validoDe: folha.validity.notBefore.toISOString(),
    validoAte: folha.validity.notAfter.toISOString(),
    emissor: folha.issuer.getField('CN')?.value || '',
  };
}

// OID 2.16.76.1.3.3 = CNPJ da pessoa jurídica; 2.16.76.1.3.1 = dados do titular (CPF nas pos. 9-19).
function documentoDoSAN(cert) {
  try {
    const ext = cert.getExtension('subjectAltName');
    if (!ext) return '';
    for (const alt of ext.altNames || []) {
      if (alt.type !== 0 || !alt.value) continue; // otherName
      const asn1 = alt.value;
      const oid = forge.asn1.derToOid(asn1[0]?.value || '');
      const inner = asn1[1]?.value?.[0]?.value;
      const txt = typeof inner === 'string' ? inner : '';
      if (oid === '2.16.76.1.3.3') return txt.replace(/[^0-9A-Z]/gi, '');
    }
  } catch { /* SAN fora do padrão: usa o CN */ }
  return '';
}

export function certificadoVencido(info, agora = new Date()) {
  return new Date(info.validoAte) < agora;
}
