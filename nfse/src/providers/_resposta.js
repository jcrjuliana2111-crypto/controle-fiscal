import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

export function parseXml(xml) {
  return parser.parse(xml);
}

/** Desembrulha o envelope SOAP e devolve o XML de retorno (que costuma vir escapado). */
export function corpoSoap(texto) {
  const doc = parseXml(texto);
  const body = doc?.Envelope?.Body;
  if (!body) return texto;
  if (body.Fault) {
    const f = body.Fault;
    throw new Error(`SOAP Fault: ${f.faultstring || f.Reason?.Text?.['#text'] || f.Reason?.Text || JSON.stringify(f)}`);
  }
  // Procura o primeiro valor string que pareça XML (outputXML, RetornoXML, return...)
  let achado = null;
  const walk = (o) => {
    if (achado) return;
    if (typeof o === 'string' && o.trim().startsWith('<')) { achado = o; return; }
    if (o && typeof o === 'object') for (const v of Object.values(o)) walk(v);
  };
  walk(body);
  if (achado) return achado;
  // Retorno já como XML estruturado dentro do Body.
  const m = texto.match(/<(?:\w+:)?Body[^>]*>([\s\S]*)<\/(?:\w+:)?Body>/);
  return m ? m[1] : texto;
}

/** Busca recursiva por todas as ocorrências de uma chave. */
export function todos(obj, chave) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (k === chave) Array.isArray(v) ? out.push(...v) : out.push(v);
      walk(v);
    }
  };
  walk(obj);
  return out;
}

export function primeiro(obj, chave) {
  return todos(obj, chave)[0];
}

export function texto(v) {
  if (v == null) return '';
  if (typeof v === 'object') return v['#text'] ?? '';
  return String(v);
}
