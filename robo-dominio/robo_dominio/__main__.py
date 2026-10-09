"""Linha de comando do robô.

Exemplos:
  python -m robo_dominio ciclo --competencia 2026-09
  python -m robo_dominio ciclo --competencia 2026-09 --etapas conferir,entregar --empresa 123
  python -m robo_dominio ciclo --competencia 2026-09 --simular --sem-painel
  python -m robo_dominio conferir --tipo sped_fiscal --arquivo SPED.txt --cnpj 12345678000199 --competencia 2026-09 --xml D:\\XML\\123\\202609
  python -m robo_dominio mapear --janela "Domínio"
  python -m robo_dominio receita importar_xml --empresa 123 --competencia 2026-09 --passo-a-passo
"""

import argparse
import json
import sys
from datetime import date
from pathlib import Path

from . import ciclo, conferencia
from . import config as config_mod
from .painel import Painel, PainelLocal
from .rpa import Robo


def competencia_anterior():
    hoje = date.today()
    ano, mes = (hoje.year, hoje.month - 1) if hoje.month > 1 else (hoje.year - 1, 12)
    return f"{ano:04d}-{mes:02d}"


def _robo(cfg, args):
    return Robo(cfg["dominio"], cfg["_receitas"], cfg["pastas"].get("evidencias", cfg["_base"] / "evidencias"),
                simular=getattr(args, "simular", False), passo_a_passo=getattr(args, "passo_a_passo", False))


def _painel(cfg, args):
    if getattr(args, "sem_painel", False) or not cfg["painel"].get("url"):
        return PainelLocal(cfg["_base"] / "dados_local.json", cfg.get("empresas"))
    return Painel(cfg["painel"]["url"])


def main(argv=None):
    ap = argparse.ArgumentParser(prog="robo_dominio", description="Robô de obrigações acessórias — Domínio Sistemas")
    ap.add_argument("--config", default="config.yaml")
    sub = ap.add_subparsers(dest="comando", required=True)

    p = sub.add_parser("ciclo", help="executa importação, geração, conferência e entrega")
    p.add_argument("--competencia", default=competencia_anterior(), help="AAAA-MM (padrão: mês anterior)")
    p.add_argument("--empresa", action="append", help="código Domínio (pode repetir)")
    p.add_argument("--obrigacao", action="append", help="código da obrigação (pode repetir)")
    p.add_argument("--etapas", default=",".join(ciclo.ETAPAS))
    p.add_argument("--simular", action="store_true", help="só mostra os passos, não clica nem grava no painel")
    p.add_argument("--passo-a-passo", action="store_true", help="pede ENTER antes de cada passo (calibração)")
    p.add_argument("--sem-painel", action="store_true", help="usa empresas do config e grava em dados_local.json")

    p = sub.add_parser("conferir", help="confere um arquivo avulso, sem RPA")
    p.add_argument("--tipo", required=True, choices=["sped_fiscal", "sped_contrib", "arquivo"])
    p.add_argument("--arquivo", required=True)
    p.add_argument("--cnpj", default="")
    p.add_argument("--competencia", required=True)
    p.add_argument("--xml", help="pasta com XMLs para cruzar com o C100")
    p.add_argument("--json", action="store_true")

    p = sub.add_parser("receita", help="executa uma receita isolada (para calibrar)")
    p.add_argument("nome")
    p.add_argument("--empresa", required=True, help="código Domínio")
    p.add_argument("--competencia", default=competencia_anterior())
    p.add_argument("--obrigacao", default="")
    p.add_argument("--simular", action="store_true")
    p.add_argument("--passo-a-passo", action="store_true")
    p.add_argument("--sem-painel", action="store_true")

    p = sub.add_parser("mapear", help="grava os controles da janela aberta do Domínio")
    p.add_argument("--janela", default="Domínio")
    p.add_argument("--saida", default="mapa_controles.txt")

    args = ap.parse_args(argv)

    if args.comando == "conferir":
        res = conferencia.conferir(args.tipo, args.arquivo, args.cnpj, args.competencia, pasta_xml=args.xml)
        if args.json:
            print(json.dumps(res.para_dict(), ensure_ascii=False, indent=2))
        else:
            for a in res.apontamentos:
                print(f"[{a['nivel'].upper():6}] {a['codigo']}: {a['mensagem']}")
            print("\nResumo:", json.dumps(res.para_dict()["resumo"], ensure_ascii=False))
            print("RESULTADO:", "OK" if res.ok else "DIVERGENTE")
        return 0 if res.ok else 2

    cfg = config_mod.carregar(args.config)

    if args.comando == "mapear":
        destino = _robo(cfg, args).mapear(args.janela, args.saida)
        print(f"Controles gravados em {destino}")
        return 0

    if args.comando == "receita":
        painel = _painel(cfg, args)
        emp = next((e for e in painel.empresas() if str(e.get("codigo_dominio")) == str(args.empresa)), None)
        if not emp:
            print(f"Empresa {args.empresa} não cadastrada no painel")
            return 1
        _robo(cfg, args).executar(args.nome, ciclo.variaveis(cfg, emp, args.competencia, args.obrigacao))
        return 0

    etapas = [e.strip() for e in args.etapas.split(",") if e.strip()]
    invalidas = set(etapas) - set(ciclo.ETAPAS)
    if invalidas:
        print(f"Etapas inválidas: {', '.join(invalidas)}. Use: {', '.join(ciclo.ETAPAS)}")
        return 1
    robo = _robo(cfg, args)
    resumo = ciclo.Ciclo(cfg, _painel(cfg, args), robo).executar(
        args.competencia, args.empresa, args.obrigacao, etapas)
    print("\nResumo:", json.dumps(resumo, ensure_ascii=False))
    return 1 if resumo["erros"] else 0


if __name__ == "__main__":
    sys.exit(main())
