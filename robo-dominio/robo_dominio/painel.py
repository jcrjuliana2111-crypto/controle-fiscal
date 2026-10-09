"""Comunicação com o painel (Supabase via função smart-handler).

PainelLocal guarda tudo num arquivo JSON — útil para testar o robô sem
mexer nos dados reais (opção --sem-painel).
"""

import json
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


def agora():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def id_entrega(empresa_id, obrigacao, competencia):
    return f"{empresa_id}|{obrigacao}|{competencia}"


class Painel:
    def __init__(self, url, timeout=60):
        self.url = url
        self.timeout = timeout

    def _post(self, acao, corpo):
        cab = {"Content-Type": "application/json", "x-action": acao}
        req = urllib.request.Request(self.url, data=json.dumps(corpo, default=str).encode(), headers=cab, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                txt = r.read().decode() or "null"
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"Painel respondeu HTTP {e.code}: {e.read().decode(errors='ignore')[:300]}") from e
        return json.loads(txt)

    def empresas(self):
        return self._post("obr-get", {"tabela": "empresas"}) or []

    def entregas(self, competencia):
        return self._post("obr-get", {"tabela": "entregas", "competencia": competencia}) or []

    def salvar_entrega(self, entrega):
        entrega = dict(entrega, updated_at=agora())
        self._post("obr-upsert", {"tabela": "entregas", "rows": [entrega]})


class PainelLocal:
    def __init__(self, arquivo, empresas_config):
        self.arquivo = Path(arquivo)
        self._empresas = empresas_config or []
        self._dados = json.loads(self.arquivo.read_text("utf-8")) if self.arquivo.is_file() else {}

    def empresas(self):
        return self._empresas

    def entregas(self, competencia):
        return [e for e in self._dados.values() if e.get("competencia") == competencia]

    def salvar_entrega(self, entrega):
        self._dados[entrega["id"]] = dict(entrega, updated_at=agora())
        self.arquivo.parent.mkdir(parents=True, exist_ok=True)
        self.arquivo.write_text(json.dumps(self._dados, ensure_ascii=False, indent=2, default=str), "utf-8")
