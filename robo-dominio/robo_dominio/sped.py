"""Leitura de arquivos SPED (EFD ICMS/IPI e EFD Contribuições) gerados pelo Domínio."""

from collections import Counter
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path


def num(valor):
    """Converte número no formato SPED ("1234,56") para Decimal. Vazio vira 0."""
    valor = (valor or "").strip()
    if not valor:
        return Decimal("0")
    try:
        return Decimal(valor.replace(".", "").replace(",", ".")) if "," in valor else Decimal(valor)
    except InvalidOperation:
        return Decimal("0")


def data(valor):
    """Converte data SPED (ddmmaaaa) para ISO (aaaa-mm-dd). Retorna '' se inválida."""
    valor = (valor or "").strip()
    if len(valor) != 8 or not valor.isdigit():
        return ""
    return f"{valor[4:]}-{valor[2:4]}-{valor[:2]}"


def so_digitos(valor):
    return "".join(c for c in (valor or "") if c.isdigit())


@dataclass
class ArquivoSped:
    caminho: Path
    linhas: list = field(default_factory=list)       # cada linha: lista de campos (campo 0 = REG)
    malformadas: list = field(default_factory=list)  # números das linhas fora do padrão |...|

    def registros(self, reg):
        return [l for l in self.linhas if l[0] == reg]

    def primeiro(self, reg):
        for l in self.linhas:
            if l[0] == reg:
                return l
        return None

    def contagem(self):
        return Counter(l[0] for l in self.linhas)


def ler(caminho):
    """Lê o arquivo SPED. A leitura para no registro 9999 (ignora a assinatura digital)."""
    caminho = Path(caminho)
    texto = caminho.read_bytes().decode("latin-1")
    arq = ArquivoSped(caminho)
    for n, bruta in enumerate(texto.splitlines(), 1):
        bruta = bruta.strip()
        if not bruta:
            continue
        if not (bruta.startswith("|") and bruta.endswith("|")) or len(bruta) < 6:
            arq.malformadas.append(n)
            continue
        campos = bruta[1:-1].split("|")
        arq.linhas.append(campos)
        if campos[0] == "9999":
            break
    return arq


# Posição dos campos do registro 0000 em cada leiaute
CABECALHO = {
    "sped_fiscal": {"dt_ini": 3, "dt_fin": 4, "nome": 5, "cnpj": 6, "uf": 8, "ie": 9},
    "sped_contrib": {"dt_ini": 5, "dt_fin": 6, "nome": 7, "cnpj": 8, "uf": 9, "ie": None},
}


def cabecalho(arq, leiaute):
    reg = arq.primeiro("0000")
    if not reg:
        return None
    pos = CABECALHO[leiaute]

    def campo(nome):
        i = pos[nome]
        return reg[i] if i is not None and i < len(reg) else ""

    return {
        "dt_ini": data(campo("dt_ini")),
        "dt_fin": data(campo("dt_fin")),
        "nome": campo("nome"),
        "cnpj": so_digitos(campo("cnpj")),
        "uf": campo("uf"),
        "ie": campo("ie"),
    }
