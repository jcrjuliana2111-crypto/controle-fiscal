"""Conferência dos arquivos gerados pelo Domínio antes da entrega.

Cada verificação gera apontamentos:
- "erro":   impede a entrega automática (a obrigação fica como "divergente")
- "alerta": precisa de olhar humano, mas não bloqueia
- "info":   só registro
"""

import calendar
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path

from . import nfe, sped

TOLERANCIA = Decimal("0.01")

# Registros analíticos de ICMS com o mesmo leiaute: |REG|CST|CFOP|ALIQ|VL_OPR|VL_BC|VL_ICMS|...
ANALITICOS_ICMS = {"C190", "C320", "C390", "C490", "C590", "C690", "C790", "C850", "C890", "D190", "D590"}


@dataclass
class Resultado:
    apontamentos: list = field(default_factory=list)
    resumo: dict = field(default_factory=dict)

    def add(self, nivel, codigo, mensagem):
        self.apontamentos.append({"nivel": nivel, "codigo": codigo, "mensagem": mensagem})

    def erro(self, codigo, mensagem):
        self.add("erro", codigo, mensagem)

    def alerta(self, codigo, mensagem):
        self.add("alerta", codigo, mensagem)

    def info(self, codigo, mensagem):
        self.add("info", codigo, mensagem)

    @property
    def erros(self):
        return [a for a in self.apontamentos if a["nivel"] == "erro"]

    @property
    def alertas(self):
        return [a for a in self.apontamentos if a["nivel"] == "alerta"]

    @property
    def ok(self):
        return not self.erros

    def para_dict(self):
        return {
            "ok": self.ok,
            "erros": len(self.erros),
            "alertas": len(self.alertas),
            "apontamentos": self.apontamentos,
            "resumo": {k: (str(v) if isinstance(v, Decimal) else v) for k, v in self.resumo.items()},
        }


def limites_competencia(competencia):
    """'2026-09' -> ('2026-09-01', '2026-09-30')"""
    ano, mes = (int(x) for x in competencia.split("-"))
    ultimo = calendar.monthrange(ano, mes)[1]
    return f"{ano:04d}-{mes:02d}-01", f"{ano:04d}-{mes:02d}-{ultimo:02d}"


def _fmt(v):
    return f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


# ---------------------------------------------------------------- estrutura
def verificar_estrutura(arq, res):
    if arq.malformadas:
        amostra = ", ".join(str(n) for n in arq.malformadas[:10])
        res.erro("LINHA_INVALIDA", f"{len(arq.malformadas)} linha(s) fora do padrão |REG|...| (linhas {amostra})")

    if not arq.primeiro("0000"):
        res.erro("SEM_0000", "Registro 0000 (abertura) não encontrado")
    fim = arq.primeiro("9999")
    if not fim:
        res.erro("SEM_9999", "Registro 9999 (encerramento) não encontrado — arquivo truncado?")
    elif int(sped.num(fim[1])) != len(arq.linhas):
        res.erro("QTD_LINHAS", f"9999 informa {fim[1]} linhas, arquivo tem {len(arq.linhas)}")

    contagem = arq.contagem()
    for reg in arq.registros("9900"):
        if len(reg) < 3:
            continue
        informado, real = int(sped.num(reg[2])), contagem.get(reg[1], 0)
        if informado != real:
            res.erro("9900", f"9900 informa {informado} registro(s) {reg[1]}, arquivo tem {real}")

    por_bloco = {}
    for l in arq.linhas:
        por_bloco[l[0][0]] = por_bloco.get(l[0][0], 0) + 1
    for bloco, qtd in por_bloco.items():
        enc = arq.primeiro(f"{bloco}990")
        if enc is None:
            res.erro("SEM_ENCERRAMENTO", f"Bloco {bloco} sem registro {bloco}990")
        elif int(sped.num(enc[1])) != qtd:
            res.erro("QTD_BLOCO", f"{bloco}990 informa {enc[1]} linhas, bloco {bloco} tem {qtd}")


def verificar_cabecalho(arq, leiaute, cnpj, competencia, res):
    cab = sped.cabecalho(arq, leiaute)
    if not cab:
        return None
    ini, fim = limites_competencia(competencia)
    res.resumo["contribuinte"] = cab["nome"]
    res.resumo["periodo"] = f"{cab['dt_ini']} a {cab['dt_fin']}"

    cnpj = sped.so_digitos(cnpj)
    if cnpj and cab["cnpj"] != cnpj:
        res.erro("CNPJ", f"CNPJ do arquivo ({cab['cnpj']}) difere do cadastro ({cnpj}) — empresa errada no Domínio?")
    if cab["dt_fin"] != fim or cab["dt_ini"] > fim or cab["dt_ini"] < ini:
        res.erro("PERIODO", f"Período do arquivo {cab['dt_ini']} a {cab['dt_fin']} não é a competência {competencia}")
    elif cab["dt_ini"] != ini:
        res.alerta("PERIODO_PARCIAL", f"Período inicia em {cab['dt_ini']} (início de atividade ou situação especial?)")
    return cab


# ---------------------------------------------------------------- EFD ICMS/IPI
def verificar_apuracao_icms(arq, res):
    e110 = arq.registros("E110")
    if not e110:
        res.alerta("SEM_E110", "Sem registro E110 (apuração do ICMS)")
        return
    if len(e110) > 1:
        res.info("E110_MULTIPLO", f"{len(e110)} períodos de apuração de ICMS no arquivo; conferindo totais pelo somatório")

    v = [sped.num(x) for x in e110[0][1:14]] if len(e110) == 1 else None
    debitos = sum(sped.num(r[1]) for r in e110)
    creditos = sum(sped.num(r[5]) for r in e110)
    a_recolher = sum(sped.num(r[12]) for r in e110 if len(r) > 12)
    credor = sum(sped.num(r[13]) for r in e110 if len(r) > 13)
    res.resumo.update({
        "icms_debitos": debitos, "icms_creditos": creditos,
        "icms_a_recolher": a_recolher, "icms_saldo_credor": credor,
    })

    # Débitos/créditos dos documentos (analíticos) x apuração
    deb_docs = cred_docs = Decimal("0")
    for l in arq.linhas:
        if l[0] in ANALITICOS_ICMS and len(l) > 6:
            cfop = l[2][:1]
            if cfop in "567":
                deb_docs += sped.num(l[6])
            elif cfop in "123":
                cred_docs += sped.num(l[6])
    if abs(deb_docs - debitos) > TOLERANCIA:
        res.alerta("DEBITOS_DOCS", f"Débitos dos documentos ({_fmt(deb_docs)}) ≠ VL_TOT_DEBITOS do E110 ({_fmt(debitos)})")
    if abs(cred_docs - creditos) > TOLERANCIA:
        res.alerta("CREDITOS_DOCS", f"Créditos dos documentos ({_fmt(cred_docs)}) ≠ VL_TOT_CREDITOS do E110 ({_fmt(creditos)})")

    if v and len(v) == 13:
        (tot_deb, aj_deb, tot_aj_deb, est_cred, tot_cred, aj_cred, tot_aj_cred,
         est_deb, sld_ant, sld_apurado, tot_ded, recolher, credor_transp) = v[:13]
        saldo = (tot_deb + aj_deb + tot_aj_deb + est_cred) - (tot_cred + aj_cred + tot_aj_cred + est_deb + sld_ant)
        if saldo >= 0:
            if abs(saldo - sld_apurado) > TOLERANCIA:
                res.erro("E110_SALDO", f"Saldo apurado deveria ser {_fmt(saldo)}, E110 informa {_fmt(sld_apurado)}")
            if abs((sld_apurado - tot_ded) - recolher) > TOLERANCIA:
                res.erro("E110_RECOLHER", f"ICMS a recolher deveria ser {_fmt(sld_apurado - tot_ded)}, E110 informa {_fmt(recolher)}")
        elif abs(-saldo - credor_transp) > TOLERANCIA:
            res.erro("E110_CREDOR", f"Saldo credor a transportar deveria ser {_fmt(-saldo)}, E110 informa {_fmt(credor_transp)}")


def verificar_xmls(arq, pasta_xml, cnpj, competencia, res):
    """Cruza o C100 com os XMLs exportados/baixados para a competência."""
    notas, canceladas = nfe.ler_pasta(pasta_xml)
    if not notas and not canceladas:
        res.alerta("SEM_XML", f"Nenhum XML encontrado em {pasta_xml} — cruzamento com NF-e não realizado")
        return
    cnpj = sped.so_digitos(cnpj)
    ini, fim = limites_competencia(competencia)

    escrituradas = {}
    for l in arq.registros("C100"):
        if len(l) > 11 and l[4] in ("55", "65") and l[8]:
            escrituradas[l[8]] = {
                "ind_emit": l[2], "cod_sit": l[5], "num": l[7], "vl_doc": sped.num(l[11]),
            }

    proprias = terceiros = 0
    for chave, nota in notas.items():
        cancelada = chave in canceladas
        if nota["cnpj_emit"] == cnpj:
            proprias += 1
            if not cancelada and ini <= nota["data"] <= fim and chave not in escrituradas:
                res.erro("NFE_NAO_ESCRITURADA", f"NF-e própria {nota['numero']} ({chave}) autorizada e fora do SPED")
        elif nota["cnpj_dest"] == cnpj:
            terceiros += 1
            if not cancelada and chave not in escrituradas:
                res.alerta("ENTRADA_NAO_ESCRITURADA",
                           f"NF-e de entrada {nota['numero']} ({chave}) não está neste SPED — escriturada em outro mês?")
        else:
            continue
        doc = escrituradas.get(chave)
        if doc and not cancelada and doc["cod_sit"] not in ("02", "03") and abs(doc["vl_doc"] - nota["vnf"]) > TOLERANCIA:
            res.erro("VALOR_NFE", f"NF-e {nota['numero']}: valor no SPED {_fmt(doc['vl_doc'])} ≠ XML {_fmt(nota['vnf'])}")

    for chave in canceladas:
        doc = escrituradas.get(chave)
        if doc and doc["cod_sit"] not in ("02", "03"):
            res.erro("CANCELADA_ATIVA", f"NF-e {doc['num']} ({chave}) está cancelada mas foi escriturada como regular (COD_SIT {doc['cod_sit']})")

    for chave, doc in escrituradas.items():
        if doc["ind_emit"] == "0" and chave not in notas and chave not in canceladas:
            res.alerta("SEM_XML_PROPRIA", f"NF-e própria {doc['num']} ({chave}) está no SPED, mas o XML não está na pasta")

    res.resumo.update({"xml_proprias": proprias, "xml_terceiros": terceiros, "c100_nfe": len(escrituradas)})


# ---------------------------------------------------------------- EFD Contribuições
def verificar_apuracao_contrib(arq, res):
    for reg, tributo in (("M200", "pis"), ("M600", "cofins")):
        linha = arq.primeiro(reg)
        if not linha:
            res.alerta(f"SEM_{reg}", f"Sem registro {reg} (apuração do {tributo.upper()})")
            continue
        v = [sped.num(x) for x in linha[1:13]] + [Decimal("0")] * 12
        (nc_per, cred_desc, cred_ant, nc_dev, ret_nc, out_nc, nc_rec,
         cum_per, ret_cum, out_cum, cum_rec, tot_rec) = v[:12]
        res.resumo[f"{tributo}_a_recolher"] = tot_rec
        if abs((nc_per - cred_desc - cred_ant) - nc_dev) > TOLERANCIA:
            res.erro(f"{reg}_DEVIDA", f"{reg}: contribuição não cumulativa devida deveria ser {_fmt(nc_per - cred_desc - cred_ant)}, informado {_fmt(nc_dev)}")
        if abs((nc_dev - ret_nc - out_nc) - nc_rec) > TOLERANCIA:
            res.erro(f"{reg}_NC_REC", f"{reg}: não cumulativa a recolher deveria ser {_fmt(nc_dev - ret_nc - out_nc)}, informado {_fmt(nc_rec)}")
        if abs((cum_per - ret_cum - out_cum) - cum_rec) > TOLERANCIA:
            res.erro(f"{reg}_CUM_REC", f"{reg}: cumulativa a recolher deveria ser {_fmt(cum_per - ret_cum - out_cum)}, informado {_fmt(cum_rec)}")
        if abs((nc_rec + cum_rec) - tot_rec) > TOLERANCIA:
            res.erro(f"{reg}_TOTAL", f"{reg}: total a recolher deveria ser {_fmt(nc_rec + cum_rec)}, informado {_fmt(tot_rec)}")


# ---------------------------------------------------------------- entrada
def conferir(tipo, arquivo, cnpj, competencia, pasta_xml=None):
    """Confere um arquivo conforme o tipo do catálogo. Retorna Resultado."""
    res = Resultado()
    if tipo == "nenhuma":
        res.info("SEM_ARQUIVO", "Obrigação sem arquivo local para conferir")
        return res
    if not arquivo or not Path(arquivo).is_file():
        res.erro("ARQUIVO_AUSENTE", f"Arquivo não encontrado: {arquivo or '(não gerado)'}")
        return res
    arquivo = Path(arquivo)
    res.resumo["arquivo"] = str(arquivo)
    if arquivo.stat().st_size == 0:
        res.erro("ARQUIVO_VAZIO", "Arquivo gerado está vazio")
        return res

    if tipo == "arquivo":
        conteudo = arquivo.read_bytes()[:5_000_000].decode("latin-1")
        cnpj_dig = sped.so_digitos(cnpj)
        if cnpj_dig and cnpj_dig not in sped.so_digitos(conteudo) and cnpj_dig not in sped.so_digitos(arquivo.name):
            res.alerta("CNPJ_NAO_ENCONTRADO", "CNPJ da empresa não aparece no arquivo — confira se é da empresa certa")
        return res

    arq = sped.ler(arquivo)
    res.resumo["linhas"] = len(arq.linhas)
    verificar_estrutura(arq, res)
    verificar_cabecalho(arq, tipo, cnpj, competencia, res)
    if tipo == "sped_fiscal":
        verificar_apuracao_icms(arq, res)
        if pasta_xml:
            verificar_xmls(arq, pasta_xml, cnpj, competencia, res)
    elif tipo == "sped_contrib":
        verificar_apuracao_contrib(arq, res)
    return res
