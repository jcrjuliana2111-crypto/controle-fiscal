"""Orquestra o ciclo importação → geração → conferência → entrega por empresa."""

import calendar
import os
import traceback
from pathlib import Path
from string import Template

from . import catalogo, conferencia, recibos
from .painel import agora, id_entrega
from .rpa import ErroRPA

ETAPAS = ("importar", "gerar", "conferir", "entregar")
FINAIS = {"transmitido", "dispensada"}


def variaveis(cfg, empresa, competencia, obrigacao=""):
    ano, mes = competencia.split("-")
    ultimo = calendar.monthrange(int(ano), int(mes))[1]
    base = {
        "codigo": str(empresa.get("codigo_dominio") or ""),
        "cnpj": "".join(c for c in (empresa.get("cnpj") or "") if c.isdigit()),
        "razao": empresa.get("razao") or "",
        "competencia": competencia, "ano": ano, "mes": mes,
        "data_inicial": f"01/{mes}/{ano}", "data_final": f"{ultimo:02d}/{mes}/{ano}",
        "obrigacao": obrigacao,
        "usuario": cfg["dominio"].get("usuario", ""),
        "senha": os.environ.get(cfg["dominio"].get("senha_env", "DOMINIO_SENHA"), ""),
    }
    pastas = cfg["pastas"]
    base["pasta_xml"] = Template(pastas.get("xml", "")).safe_substitute(base)
    base["pasta_saida"] = Template(pastas.get("saida", "")).safe_substitute(base)
    nome = Template(pastas.get("nome_arquivo", "${obrigacao}_${cnpj}_${ano}${mes}.txt")).safe_substitute(base)
    base["arquivo_saida"] = str(Path(base["pasta_saida"]) / nome) if base["pasta_saida"] else ""
    return base


def pastas_recibo(cfg, obrigacao):
    """pastas.recibos pode ser uma lista (vale para todas) ou um dict por obrigação."""
    rec = cfg["pastas"].get("recibos") or []
    if isinstance(rec, dict):
        rec = rec.get(obrigacao) or rec.get("padrao") or []
    return [rec] if isinstance(rec, str) else list(rec)


def nova_entrega(empresa, obrigacao, competencia):
    return {
        "id": id_entrega(empresa["id"], obrigacao, competencia),
        "empresa_id": empresa["id"], "obrigacao": obrigacao, "competencia": competencia,
        "status": "pendente", "etapas": {}, "conferencia": None, "log": [],
    }


class Ciclo:
    def __init__(self, cfg, painel, robo, log=print):
        self.cfg = cfg
        self.painel = painel
        self.robo = robo
        self.log = log

    # ------------------------------------------------------------ registro
    def _etapa(self, ent, etapa, status, detalhe="", **extra):
        ent.setdefault("etapas", {})[etapa] = dict({"status": status, "em": agora(), "detalhe": detalhe}, **extra)
        ent.setdefault("log", []).append({"em": agora(), "etapa": etapa, "status": status, "detalhe": detalhe})
        ent["log"] = ent["log"][-50:]
        if not self.robo.simular:
            self.painel.salvar_entrega(ent)

    def _falha(self, ent, etapa, erro):
        evid = self.robo.print(f"erro_{ent['obrigacao']}_{etapa}")
        self.log(f"   ✖ {etapa}: {erro}")
        ent["status"] = "erro"
        self._etapa(ent, etapa, "erro", str(erro), evidencia=evid)

    # ------------------------------------------------------------ execução
    def executar(self, competencia, filtro_empresas=None, filtro_obrigacoes=None, etapas=ETAPAS):
        empresas = [e for e in self.painel.empresas() if e.get("ativo", True)]
        if filtro_empresas:
            alvo = {str(x) for x in filtro_empresas}
            empresas = [e for e in empresas if str(e.get("codigo_dominio")) in alvo or e["id"] in alvo]
        existentes = {e["id"]: e for e in self.painel.entregas(competencia)}
        resumo = {"empresas": 0, "conferidas": 0, "divergentes": 0, "transmitidas": 0, "erros": 0}

        if empresas and ("importar" in etapas or "gerar" in etapas) and self.robo.tem_receita("login"):
            self.robo.executar("login", variaveis(self.cfg, empresas[0], competencia))

        for emp in empresas:
            resumo["empresas"] += 1
            self.log(f"\n■ {emp.get('codigo_dominio')} - {emp.get('razao')} ({competencia})")
            obrigacoes = [o for o in (emp.get("obrigacoes") or []) if not filtro_obrigacoes or o in filtro_obrigacoes]
            entregas = []
            for cod in obrigacoes:
                ent = existentes.get(id_entrega(emp["id"], cod, competencia)) or nova_entrega(emp, cod, competencia)
                if ent.get("status") in FINAIS:
                    self.log(f"   · {cod}: {ent['status']} — ignorada")
                    continue
                entregas.append(ent)
            if not entregas:
                continue

            vars_emp = variaveis(self.cfg, emp, competencia)
            etapa_atual = "troca_empresa"
            try:
                if ("importar" in etapas or "gerar" in etapas) and self.robo.tem_receita("trocar_empresa"):
                    self.robo.executar("trocar_empresa", vars_emp)
                if "importar" in etapas and self.robo.tem_receita("importar_xml"):
                    etapa_atual = "importacao"
                    self.robo.executar("importar_xml", vars_emp)
                    for ent in entregas:
                        if ent["status"] in ("pendente", "erro"):
                            ent["status"] = "importado"
                        self._etapa(ent, "importacao", "ok", f"XML importados de {vars_emp['pasta_xml']}")
            except Exception as e:
                for ent in entregas:
                    self._falha(ent, etapa_atual, e)
                resumo["erros"] += 1
                continue

            for ent in entregas:
                try:
                    self._obrigacao(emp, ent, competencia, etapas, resumo)
                except Exception as e:
                    if not isinstance(e, ErroRPA):
                        self.log(traceback.format_exc())
                    self._falha(ent, "robo", e)
                    resumo["erros"] += 1
        return resumo

    def _obrigacao(self, emp, ent, competencia, etapas, resumo):
        cod = ent["obrigacao"]
        defs = catalogo.obter(cod, self.cfg["obrigacoes"])
        v = variaveis(self.cfg, emp, competencia, cod)
        self.log(f"   ● {defs['nome']}")

        # Geração do arquivo no Domínio
        receita_gerar = f"gerar_{cod.lower()}"
        if "gerar" in etapas and self.robo.tem_receita(receita_gerar):
            if v["pasta_saida"] and not self.robo.simular:
                Path(v["pasta_saida"]).mkdir(parents=True, exist_ok=True)
            self.robo.executar(receita_gerar, v)
            ent["arquivo"] = v["arquivo_saida"] or None
            ent["status"] = "gerado"
            self._etapa(ent, "geracao", "ok", ent["arquivo"] or "gerado no Domínio")

        # Conferência
        if "conferir" in etapas and defs["conferencia"] != "nenhuma":
            arquivo = self._localizar_arquivo(ent, defs, v) or ent.get("arquivo") or v["arquivo_saida"]
            res = conferencia.conferir(defs["conferencia"], arquivo, emp.get("cnpj"), competencia, pasta_xml=v["pasta_xml"] or None)
            ent["arquivo"] = str(arquivo) if arquivo else None
            ent["conferencia"] = dict(res.para_dict(), em=agora())
            ent["status"] = "conferido" if res.ok else "divergente"
            resumo["conferidas" if res.ok else "divergentes"] += 1
            self.log(f"     conferência: {len(res.erros)} erro(s), {len(res.alertas)} alerta(s)")
            for a in res.erros[:5]:
                self.log(f"       ✖ {a['mensagem']}")
            self._etapa(ent, "conferencia", "ok" if res.ok else "divergente",
                        f"{len(res.erros)} erro(s), {len(res.alertas)} alerta(s)")

        # Entrega
        if "entregar" in etapas:
            self._entregar(ent, defs, v, resumo)

    def _localizar_arquivo(self, ent, defs, v):
        if ent.get("arquivo") and Path(ent["arquivo"]).is_file():
            return Path(ent["arquivo"])
        if v["arquivo_saida"] and Path(v["arquivo_saida"]).is_file():
            return Path(v["arquivo_saida"])
        pasta = Path(v["pasta_saida"]) if v["pasta_saida"] else None
        if pasta and pasta.is_dir() and defs.get("padrao_arquivo"):
            arquivos = [p for p in pasta.glob(defs["padrao_arquivo"]) if p.is_file()]
            if arquivos:
                return max(arquivos, key=lambda p: p.stat().st_mtime)
        return None

    def _entregar(self, ent, defs, v, resumo):
        modo = defs["entrega"]
        if modo == "manual":
            return
        cfg_ent = self.cfg["entrega"]
        if modo == "dominio":
            receita = f"transmitir_{ent['obrigacao'].lower()}"
            if not cfg_ent.get("permitir_transmissao_automatica"):
                self.log("     entrega automática desligada no config — aguardando transmissão pela equipe")
            elif ent["status"] == "divergente":
                self.log("     ✋ não transmitido: conferência com erros")
            elif not self.robo.tem_receita(receita):
                self.log(f"     sem receita '{receita}' — transmissão manual")
            else:
                self.robo.executar(receita, v)
                self._etapa(ent, "entrega", "enviado", "transmitido pelo Domínio — aguardando recibo")

        pastas = [Template(p).safe_substitute(v) for p in pastas_recibo(self.cfg, ent["obrigacao"])]
        if not pastas:
            return
        rec = recibos.localizar(pastas, v["cnpj"], v["competencia"], cfg_ent.get("regex_recibo"))
        if rec:
            ent["status"] = "transmitido"
            ent["recibo"] = rec["numero"]
            ent["recibo_arquivo"] = rec["arquivo"]
            resumo["transmitidas"] += 1
            self.log(f"     ✔ recibo {rec['numero']}")
            self._etapa(ent, "entrega", "ok", f"Recibo {rec['numero']}", arquivo=rec["arquivo"])
