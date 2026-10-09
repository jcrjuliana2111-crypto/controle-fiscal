"""Carregamento do config.yaml e das receitas."""

from pathlib import Path

import yaml


def carregar(caminho):
    caminho = Path(caminho)
    if not caminho.is_file():
        raise SystemExit(f"Config não encontrado: {caminho}. Copie config.exemplo.yaml para config.yaml e ajuste.")
    cfg = yaml.safe_load(caminho.read_text("utf-8")) or {}
    cfg.setdefault("painel", {})
    cfg.setdefault("dominio", {})
    cfg.setdefault("pastas", {})
    cfg.setdefault("entrega", {})
    cfg.setdefault("obrigacoes", {})

    arq_receitas = Path(cfg.get("receitas", "receitas.yaml"))
    if not arq_receitas.is_absolute():
        arq_receitas = caminho.parent / arq_receitas
    cfg["_receitas"] = yaml.safe_load(arq_receitas.read_text("utf-8")) if arq_receitas.is_file() else {}
    cfg["_base"] = caminho.parent
    return cfg
