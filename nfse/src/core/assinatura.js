import { SignedXml } from 'xml-crypto';

const ALG = {
  sha1: {
    sig: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    digest: 'http://www.w3.org/2000/09/xmldsig#sha1',
  },
  sha256: {
    sig: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    digest: 'http://www.w3.org/2001/04/xmlenc#sha256',
  },
};
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

/**
 * Assinatura XMLDSig enveloped.
 *
 * @param {string} xml
 * @param {object} o
 * @param {{keyPem:string, certPem:string}} o.cert
 * @param {string} [o.elemento]  nome local do elemento com atributo Id a ser referenciado.
 *                               Se omitido, assina o documento inteiro (Reference URI="").
 * @param {'sha1'|'sha256'} [o.algoritmo]
 * @param {'after'|'append'} [o.posicao]  'after' = Signature como irmã do elemento
 *                               (padrão Nacional/ABRASF); 'append' = último filho da raiz.
 */
export function assinarXml(xml, { cert, elemento, algoritmo = 'sha256', posicao = 'after' }) {
  const alg = ALG[algoritmo];
  const sig = new SignedXml({
    privateKey: cert.keyPem,
    publicCert: cert.certPem,
    signatureAlgorithm: alg.sig,
    canonicalizationAlgorithm: C14N,
  });
  // Só o certificado do titular no KeyInfo (sem a cadeia), como pedem os manuais.
  sig.getKeyInfoContent = () =>
    `<X509Data><X509Certificate>${cert.certPem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, '')}</X509Certificate></X509Data>`;

  if (elemento) {
    const xp = `//*[local-name(.)='${elemento}']`;
    sig.addReference({ xpath: xp, transforms: [ENVELOPED, C14N], digestAlgorithm: alg.digest });
    sig.computeSignature(xml, {
      location: posicao === 'after'
        ? { reference: xp, action: 'after' }
        : { reference: '/*', action: 'append' },
    });
  } else {
    sig.addReference({ xpath: '/*', transforms: [ENVELOPED, C14N], digestAlgorithm: alg.digest, isEmptyUri: true });
    sig.computeSignature(xml, { location: { reference: '/*', action: 'append' } });
  }
  return sig.getSignedXml();
}

/** Verifica assinaturas (usado nos testes e para conferir XML devolvido). */
export function verificarAssinatura(xml, certPem) {
  const sigs = [...xml.matchAll(/<Signature[\s\S]*?<\/Signature>/g)].map((m) => m[0]);
  if (!sigs.length) return false;
  return sigs.every((s) => {
    const v = new SignedXml({ publicCert: certPem });
    v.loadSignature(s);
    return v.checkSignature(xml);
  });
}
