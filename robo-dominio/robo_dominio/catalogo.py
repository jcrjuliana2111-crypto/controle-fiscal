"""Catálogo de obrigações acessórias tratadas pelo robô.

Os códigos são os mesmos usados no painel (obrigacoes.html) e na tabela
obr_entregas do Supabase. Cada obrigação diz:

- conferencia: como o arquivo gerado no Domínio é conferido
    "sped_fiscal"  -> EFD ICMS/IPI (estrutura, cabeçalho, apuração, cruzamento com XML)
    "sped_contrib" -> EFD Contribuições (estrutura, cabeçalho, apuração M200/M600)
    "arquivo"      -> só verifica se o arquivo existe, não está vazio e cita o CNPJ
    "nenhuma"      -> obrigação sem arquivo local (ex.: DCTFWeb, transmitida no e-CAC)
- entrega: como o robô descobre que a obrigação foi entregue
    "recibo"  -> procura o recibo (ReceitaNet/PVA ou pasta configurada)
    "dominio" -> transmite pelo próprio Domínio com uma receita RPA (só se liberado no config)
    "manual"  -> a equipe informa o recibo no painel
- padrao_arquivo: glob usado para achar o arquivo gerado na pasta de saída

Tudo pode ser sobrescrito na seção "obrigacoes" do config.yaml.
"""

CATALOGO = {
    "EFD_ICMS_IPI": {
        "nome": "EFD ICMS/IPI (SPED Fiscal)",
        "esfera": "Estadual",
        "conferencia": "sped_fiscal",
        "entrega": "recibo",
        "padrao_arquivo": "*.txt",
    },
    "EFD_CONTRIB": {
        "nome": "EFD Contribuições",
        "esfera": "Federal",
        "conferencia": "sped_contrib",
        "entrega": "recibo",
        "padrao_arquivo": "*.txt",
    },
    "EFD_REINF": {
        "nome": "EFD-Reinf",
        "esfera": "Federal",
        "conferencia": "nenhuma",
        "entrega": "dominio",
        "padrao_arquivo": "",
    },
    "ESOCIAL": {
        "nome": "eSocial (fechamento)",
        "esfera": "Federal",
        "conferencia": "nenhuma",
        "entrega": "dominio",
        "padrao_arquivo": "",
    },
    "DCTFWEB": {
        "nome": "DCTFWeb",
        "esfera": "Federal",
        "conferencia": "nenhuma",
        "entrega": "manual",
        "padrao_arquivo": "",
    },
    "PGDASD": {
        "nome": "PGDAS-D (Simples Nacional)",
        "esfera": "Federal",
        "conferencia": "nenhuma",
        "entrega": "manual",
        "padrao_arquivo": "",
    },
    "DESTDA": {
        "nome": "DeSTDA",
        "esfera": "Estadual",
        "conferencia": "arquivo",
        "entrega": "recibo",
        "padrao_arquivo": "*.txt",
    },
    "GIA": {
        "nome": "GIA estadual",
        "esfera": "Estadual",
        "conferencia": "arquivo",
        "entrega": "recibo",
        "padrao_arquivo": "*",
    },
    "ISS": {
        "nome": "Declaração de ISS (municipal)",
        "esfera": "Municipal",
        "conferencia": "arquivo",
        "entrega": "manual",
        "padrao_arquivo": "*",
    },
}


def obter(codigo, sobrescritas=None):
    """Retorna a definição da obrigação, aplicando sobrescritas do config."""
    base = dict(CATALOGO.get(codigo, {
        "nome": codigo, "esfera": "", "conferencia": "arquivo",
        "entrega": "manual", "padrao_arquivo": "*",
    }))
    base.update((sobrescritas or {}).get(codigo, {}))
    return base
