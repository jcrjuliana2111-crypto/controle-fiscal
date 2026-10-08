import crypto from 'node:crypto';
import { db } from '../store/db.js';
import { provedor } from '../providers/index.js';
import { resolverMunicipio } from './municipios.js';
import { lerCertificado, certificadoVencido } from './certificado.js';
import { validarNota } from './validacao.js';
import { calcular } from './calculo.js';
import { cifrar, decifrar } from '../util/segredo.js';
import { normDoc } from '../util/xml.js';

// ------------------------------------------------------------- prestadores

const publico = (p) => {
  if (!p) return p;
  const { certificado, ...resto } = p;
  return { ...resto, certificado: certificado ? { ...certificado, pfx: undefined, senha: undefined } : null };
};

export function listarPrestadores() {
  return db.get().prestadores.map(publico);
}

export function obterPrestador(id) {
  return db.get().prestadores.find((p) => p.id === id);
}

export function salvarPrestador(dados) {
  const campos = ['razaoSocial', 'nomeFantasia', 'documento', 'inscricaoMunicipal', 'codigoMunicipio', 'municipio', 'uf',
    'email', 'fone', 'opSimpNac', 'regApTribSN', 'regEspTrib', 'incentivoFiscal', 'serie', 'proximoNumero',
    'ambiente', 'provedor', 'aliquotaPadrao', 'itemListaPadrao', 'codigoTributacaoNacionalPadrao', 'endereco'];
  const limpo = Object.fromEntries(campos.filter((c) => dados[c] !== undefined).map((c) => [c, dados[c]]));
  if (limpo.documento) limpo.documento = normDoc(limpo.documento);
  return publico(db.update((d) => {
    let p = dados.id && d.prestadores.find((x) => x.id === dados.id);
    if (p) Object.assign(p, limpo, { atualizadoEm: new Date().toISOString() });
    else {
      p = { id: crypto.randomUUID(), serie: '1', proximoNumero: 1, ambiente: 'homologacao', provedor: 'auto',
        opSimpNac: 1, regEspTrib: 0, ...limpo, criadoEm: new Date().toISOString() };
      d.prestadores.push(p);
    }
    return p;
  }));
}

export function removerPrestador(id) {
  db.update((d) => { d.prestadores = d.prestadores.filter((p) => p.id !== id); });
}

export function instalarCertificado(id, pfx, senha) {
  const info = lerCertificado(pfx, senha);
  if (certificadoVencido(info)) throw new Error(`Certificado vencido em ${info.validoAte.slice(0, 10)}.`);
  return publico(db.update((d) => {
    const p = d.prestadores.find((x) => x.id === id);
    if (!p) throw new Error('Prestador não encontrado.');
    const raiz = (s) => normDoc(s).slice(0, 8);
    const aviso = info.documento && raiz(info.documento) !== raiz(p.documento)
      ? `Atenção: o certificado pertence ao documento ${info.documento}, diferente do prestador.` : '';
    p.certificado = {
      titular: info.titular, documento: info.documento, emissor: info.emissor,
      validoDe: info.validoDe, validoAte: info.validoAte, aviso,
      pfx: cifrar(pfx), senha: cifrar(senha),
    };
    return p;
  }));
}

function carregarCert(p) {
  if (!p.certificado?.pfx) return null;
  return lerCertificado(decifrar(p.certificado.pfx), decifrar(p.certificado.senha).toString('utf8'));
}

function contexto(p, extra = {}) {
  const municipio = resolverMunicipio(p.codigoMunicipio, p.provedor);
  return {
    prestador: p, municipio, ambiente: p.ambiente || 'homologacao',
    cert: carregarCert(p), prov: provedor(municipio.provedorEfetivo), ...extra,
  };
}

// ------------------------------------------------------------------- notas

export function listarNotas(filtro = {}) {
  let notas = db.get().notas;
  if (filtro.prestadorId) notas = notas.filter((n) => n.prestadorId === filtro.prestadorId);
  if (filtro.status) notas = notas.filter((n) => n.status === filtro.status);
  return [...notas].sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''))
    .map(({ xmlEnvio, xmlRetorno, respostaBruta, ...n }) => n);
}

export function obterNota(id) {
  return db.get().notas.find((n) => n.id === id);
}

function validar(nota) {
  const p = obterPrestador(nota.prestadorId);
  const erros = validarNota(nota, p);
  if (erros.length) {
    const e = new Error('Dados inválidos: ' + erros.map((x) => x.mensagem).join(' '));
    e.status = 422; e.erros = erros;
    throw e;
  }
  return p;
}

/** Gera o XML (assinado, se houver certificado) sem transmitir. */
export function previsualizar(nota) {
  const p = validar(nota);
  const ctx = contexto(p, { nota, serie: p.serie || '1', numero: p.proximoNumero || 1 });
  const r = ctx.prov.gerarXml(ctx);
  return { provedor: ctx.prov.nome, ambiente: ctx.ambiente, calculo: calcular(nota.valores), ...r };
}

const filas = new Map();
/** Serializa emissões por prestador, para não repetir número de DPS/RPS. */
function naFila(chave, fn) {
  const anterior = filas.get(chave) || Promise.resolve();
  const atual = anterior.catch(() => {}).then(fn);
  filas.set(chave, atual);
  return atual;
}

export function emitir(nota) {
  const p0 = validar(nota);
  return naFila(p0.id, async () => {
    const p = obterPrestador(p0.id);
    const numero = Number(p.proximoNumero || 1);
    const serie = String(p.serie || '1');
    const ctx = contexto(p, { nota, serie, numero });
    if (!ctx.cert) throw Object.assign(new Error('Cadastre o certificado A1 do prestador antes de emitir.'), { status: 422 });

    const registro = {
      id: crypto.randomUUID(),
      prestadorId: p.id, prestadorNome: p.razaoSocial,
      provedor: ctx.prov.id, ambiente: ctx.ambiente, municipio: ctx.municipio.nome || p.municipio,
      serie, numeroRps: numero,
      competencia: nota.competencia, tomador: nota.tomador, servico: nota.servico, valores: nota.valores,
      ibsCbs: nota.ibsCbs, calculo: calcular(nota.valores),
      criadoEm: new Date().toISOString(), historico: [],
    };

    let r;
    try {
      r = await ctx.prov.emitir(ctx);
    } catch (e) {
      // Falha de comunicação: a nota pode ter sido recebida. Fica "processando"
      // e o número é consumido para não gerar DPS/RPS duplicada.
      r = { status: 'processando', mensagens: [{ codigo: 'COMUNICACAO', mensagem: e.message }] };
    }

    Object.assign(registro, {
      status: r.status, numero: r.numero || null, chaveAcesso: r.chaveAcesso || null, idDps: r.idDps || null,
      codigoVerificacao: r.codigoVerificacao || null, linkConsulta: r.linkConsulta || null,
      dataAutorizacao: r.dataAutorizacao || (r.status === 'autorizada' ? new Date().toISOString() : null),
      mensagens: r.mensagens || [], xmlEnvio: r.xmlEnvio, xmlRetorno: r.xmlRetorno,
    });
    registro.historico.push({ em: new Date().toISOString(), evento: 'emissao', status: r.status });

    db.update((d) => {
      // Rejeição ou teste (SP): o número não foi usado pelo fisco e pode ser reaproveitado.
      if (r.status === 'autorizada' || r.status === 'processando') {
        const pp = d.prestadores.find((x) => x.id === p.id);
        pp.proximoNumero = numero + 1;
      }
      d.notas.push(registro);
    });
    const { xmlEnvio, xmlRetorno, respostaBruta, ...resumo } = registro;
    return resumo;
  });
}

async function atualizarNota(id, fn) {
  const nota = obterNota(id);
  if (!nota) throw Object.assign(new Error('Nota não encontrada.'), { status: 404 });
  const p = obterPrestador(nota.prestadorId);
  const ctx = contexto(p, { nota, serie: nota.serie, numero: nota.numeroRps, ambiente: nota.ambiente });
  ctx.prov = provedor(nota.provedor);
  return fn(nota, ctx);
}

export function consultar(id) {
  return atualizarNota(id, async (nota, ctx) => {
    const r = await ctx.prov.consultar(ctx, nota);
    db.update((d) => {
      const n = d.notas.find((x) => x.id === id);
      for (const k of ['status', 'numero', 'chaveAcesso', 'codigoVerificacao', 'xmlRetorno']) if (r[k]) n[k] = r[k];
      if (r.mensagens?.length) n.mensagens = r.mensagens;
      n.historico.push({ em: new Date().toISOString(), evento: 'consulta', status: n.status });
    });
    return { ...r, xmlRetorno: undefined };
  });
}

export function cancelar(id, { codigo, motivo }) {
  return atualizarNota(id, async (nota, ctx) => {
    if (nota.status !== 'autorizada') throw Object.assign(new Error('Só é possível cancelar notas autorizadas.'), { status: 422 });
    const r = await ctx.prov.cancelar(ctx, nota, { codigo, motivo });
    db.update((d) => {
      const n = d.notas.find((x) => x.id === id);
      if (r.sucesso) {
        n.status = 'cancelada';
        n.cancelamento = { em: new Date().toISOString(), codigo, motivo, xml: r.xmlRetorno };
      }
      n.mensagens = r.mensagens;
      n.historico.push({ em: new Date().toISOString(), evento: 'cancelamento', sucesso: r.sucesso });
    });
    return { sucesso: r.sucesso, mensagens: r.mensagens };
  });
}

export function danfseOficial(id) {
  return atualizarNota(id, async (nota, ctx) => {
    if (!ctx.prov.danfse) return null;
    return ctx.prov.danfse(ctx, nota);
  });
}

export function parametrosMunicipais(prestadorId, codigoMunicipio, codigoServico) {
  const p = obterPrestador(prestadorId);
  if (!p) throw Object.assign(new Error('Prestador não encontrado.'), { status: 404 });
  const ctx = contexto(p);
  return provedor('nacional').parametrosMunicipais(ctx, codigoMunicipio, codigoServico);
}
