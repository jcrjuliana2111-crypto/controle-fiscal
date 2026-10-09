"""Localiza recibos de entrega (ReceitaNet/PVA SPED ou pastas configuradas).

O recibo é associado à empresa e à competência quando o CNPJ e o período
aparecem no nome do arquivo ou no conteúdo. O número do recibo é extraído
pela expressão regular configurada; se ela não achar nada, usa o nome do arquivo.
"""

import re
from pathlib import Path

from .sped import so_digitos

# Padrão do hash/recibo exibido pelo ReceitaNet (ex.: 1A.2B.3C.4D.5E.6F.70.81.92.A3-...)
RECIBO_PADRAO = r"[0-9A-F]{2}(?:\.[0-9A-F]{2}){5,}(?:-[0-9A-F]{2}(?:\.[0-9A-F]{2}){5,})?"
EXTENSOES = {".rec", ".txt", ".pdf", ".xml", ".html", ".htm"}
LIMITE_LEITURA = 2_000_000


def marcas_periodo(competencia):
    ano, mes = competencia.split("-")
    return [f"01{mes}{ano}", f"{mes}{ano}", f"{ano}{mes}", f"{mes}/{ano}", f"{ano}-{mes}", f"{mes}-{ano}"]


def localizar(pastas, cnpj, competencia, regex=None):
    """Retorna {'arquivo', 'numero'} do recibo mais recente encontrado, ou None."""
    cnpj = so_digitos(cnpj)
    marcas = marcas_periodo(competencia)
    padrao = re.compile(regex or RECIBO_PADRAO)
    candidatos = []
    for pasta in pastas:
        pasta = Path(pasta)
        if not pasta.is_dir():
            continue
        for arq in pasta.rglob("*"):
            if not arq.is_file() or arq.suffix.lower() not in EXTENSOES:
                continue
            with arq.open("rb") as f:
                texto = f.read(LIMITE_LEITURA).decode("latin-1", errors="ignore")
            alvo = arq.name + "\n" + texto
            if cnpj not in so_digitos(alvo):
                continue
            if not any(m in alvo for m in marcas):
                continue
            candidatos.append(arq)
    if not candidatos:
        return None
    arq = max(candidatos, key=lambda p: p.stat().st_mtime)
    with arq.open("rb") as f:
        texto = f.read(LIMITE_LEITURA).decode("latin-1", errors="ignore")
    achado = padrao.search(texto) or padrao.search(arq.name)
    return {"arquivo": str(arq), "numero": achado.group(0) if achado else arq.stem}
