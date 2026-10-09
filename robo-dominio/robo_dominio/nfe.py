"""Leitura de XMLs de NF-e/NFC-e (nota autorizada ou evento de cancelamento)."""

import xml.etree.ElementTree as ET
from decimal import Decimal, InvalidOperation
from pathlib import Path


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def _achar(el, *caminho):
    """Busca descendente pelo nome local das tags, ignorando namespaces."""
    atual = el
    for nome in caminho:
        prox = None
        for filho in atual.iter():
            if filho is not atual and _local(filho.tag) == nome:
                prox = filho
                break
        if prox is None:
            return None
        atual = prox
    return atual


def _texto(el, *caminho):
    alvo = _achar(el, *caminho)
    return (alvo.text or "").strip() if alvo is not None else ""


def _dec(valor):
    try:
        return Decimal(valor) if valor else Decimal("0")
    except InvalidOperation:
        return Decimal("0")


def ler(caminho):
    """Retorna um dict com os dados da nota/evento, ou None se o XML não for NF-e."""
    try:
        raiz = ET.parse(caminho).getroot()
    except ET.ParseError:
        return None

    inf = _achar(raiz, "infNFe")
    if inf is None:
        evento = _achar(raiz, "infEvento")
        if evento is None:
            return None
        return {
            "tipo": "evento",
            "arquivo": str(caminho),
            "chave": _texto(evento, "chNFe"),
            "tp_evento": _texto(evento, "tpEvento"),
        }
    chave = (inf.get("Id") or "").replace("NFe", "")
    emissao = _texto(inf, "ide", "dhEmi") or _texto(inf, "ide", "dEmi")
    return {
        "tipo": "nfe",
        "arquivo": str(caminho),
        "chave": chave,
        "modelo": _texto(inf, "ide", "mod"),
        "tp_nf": _texto(inf, "ide", "tpNF"),  # 0 = entrada, 1 = saída (visão do emitente)
        "numero": _texto(inf, "ide", "nNF"),
        "data": emissao[:10],
        "cnpj_emit": _texto(inf, "emit", "CNPJ"),
        "cnpj_dest": _texto(inf, "dest", "CNPJ"),
        "vnf": _dec(_texto(inf, "total", "ICMSTot", "vNF")),
        "vicms": _dec(_texto(inf, "total", "ICMSTot", "vICMS")),
        "cstat": _texto(raiz, "protNFe", "infProt", "cStat"),
    }


def ler_pasta(pasta):
    """Lê todos os XMLs de uma pasta (recursivo). Retorna (notas, chaves_canceladas)."""
    notas, canceladas = {}, set()
    pasta = Path(pasta)
    if not pasta.is_dir():
        return notas, canceladas
    for arq in sorted(pasta.rglob("*")):
        if arq.suffix.lower() != ".xml":
            continue
        doc = ler(arq)
        if not doc:
            continue
        if doc["tipo"] == "evento":
            if doc["tp_evento"] == "110111":
                canceladas.add(doc["chave"])
            continue
        if doc["cstat"] in ("101", "151"):
            canceladas.add(doc["chave"])
        notas[doc["chave"]] = doc
    return notas, canceladas
