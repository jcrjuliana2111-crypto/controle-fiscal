"""Motor de RPA que executa "receitas" (passos em YAML) nas telas do Domínio.

As telas, menus e atalhos mudam conforme a versão e a instalação do Domínio
(local, servidor ou Domínio Web via acesso remoto). Por isso nenhum clique está
fixo no código: cada processo é uma receita no arquivo receitas.yaml que você
calibra na sua máquina (use `python -m robo_dominio mapear` para listar os
controles da tela aberta).

Ações disponíveis em cada passo (campo "acao"):
  abrir            garante o Domínio aberto (inicia o executável do config se preciso)
  focar            espera a janela (regex em "janela") e a coloca em primeiro plano
  teclas           envia teclas no formato do pywinauto: "{F8}", "^s", "%a", "{ENTER}"
  digitar          digita "texto" (no controle indicado em "controle", se houver)
  clicar           clica no controle descrito em "controle" (title, auto_id, control_type, found_index)
  menu             abre um menu pelo caminho "Arquivos->Empresas"
  clicar_imagem    clica na imagem (png) na tela — para Domínio via acesso remoto
  esperar          aguarda "segundos"
  esperar_janela   aguarda a janela aparecer (ou sumir, com sumir: true) até "timeout"
  se_janela        se a janela aparecer em até "timeout" s, executa os passos de "entao"
  esperar_arquivo  aguarda o arquivo "caminho" existir e parar de crescer
  print            salva uma captura de tela na pasta de evidências
  pausa_manual     para e espera a pessoa apertar ENTER (ex.: senha do certificado)

Variáveis ${...} disponíveis: codigo, cnpj, razao, competencia, mes, ano,
data_inicial, data_final, pasta_xml, pasta_saida, arquivo_saida, obrigacao,
usuario, senha (a senha vem da variável de ambiente indicada no config).
"""

import re
import subprocess
import time
from datetime import datetime
from pathlib import Path
from string import Template


class ErroRPA(Exception):
    pass


def _sub(valor, variaveis):
    if isinstance(valor, str):
        return Template(valor).safe_substitute(variaveis)
    if isinstance(valor, dict):
        return {k: _sub(v, variaveis) for k, v in valor.items()}
    if isinstance(valor, list):
        return [_sub(v, variaveis) for v in valor]
    return valor


class Robo:
    def __init__(self, cfg_dominio, receitas, pasta_evidencias, simular=False, passo_a_passo=False, log=print):
        self.cfg = cfg_dominio or {}
        self.receitas = receitas or {}
        self.pasta_evidencias = Path(pasta_evidencias)
        self.simular = simular
        self.passo_a_passo = passo_a_passo
        self.log = log
        self.janela = None
        self._pywinauto = None

    # ------------------------------------------------------------ infraestrutura
    @property
    def pw(self):
        if self._pywinauto is None:
            try:
                import pywinauto  # noqa: F401
                from pywinauto import Desktop, keyboard
                from pywinauto.application import Application
            except ImportError as e:
                raise ErroRPA("pywinauto não instalado. No Windows: pip install -r requirements.txt") from e
            self._pywinauto = {"Desktop": Desktop, "Application": Application, "keyboard": keyboard}
        return self._pywinauto

    def _desktop(self):
        return self.pw["Desktop"](backend=self.cfg.get("backend", "uia"))

    def _achar_janela(self, regex, timeout):
        limite = time.time() + timeout
        padrao = re.compile(regex, re.I)
        while time.time() < limite:
            for jan in self._desktop().windows():
                try:
                    if jan.is_visible() and padrao.search(jan.window_text() or ""):
                        return jan
                except Exception:
                    continue
            time.sleep(0.5)
        return None

    def _controle(self, spec):
        if self.janela is None:
            raise ErroRPA("Nenhuma janela em foco — use um passo 'focar' antes")
        criterios = {k: v for k, v in spec.items() if k in ("title", "title_re", "auto_id", "control_type", "class_name", "found_index")}
        ctrl = self.janela.child_window(**criterios)
        ctrl.wait("exists enabled visible", timeout=spec.get("timeout", 30))
        return ctrl

    def print(self, nome="tela"):
        self.pasta_evidencias.mkdir(parents=True, exist_ok=True)
        destino = self.pasta_evidencias / f"{datetime.now():%Y%m%d_%H%M%S}_{re.sub(r'[^A-Za-z0-9_-]', '_', nome)}.png"
        if self.simular:
            return str(destino)
        try:
            from PIL import ImageGrab
            ImageGrab.grab().save(destino)
            return str(destino)
        except Exception as e:  # captura é evidência, não pode derrubar o robô
            self.log(f"   (não foi possível capturar a tela: {e})")
            return None

    # ------------------------------------------------------------ execução
    def tem_receita(self, nome):
        return nome in self.receitas

    def executar(self, nome, variaveis):
        if nome not in self.receitas:
            raise ErroRPA(f"Receita '{nome}' não existe em receitas.yaml")
        self.log(f"   ▶ receita {nome}")
        self._passos(self.receitas[nome], variaveis)

    def _passos(self, passos, variaveis, nivel=0):
        for i, passo in enumerate(passos, 1):
            passo = _sub(passo, variaveis)
            descricao = passo.get("descricao") or passo.get("acao")
            if passo.get("acao") in ("teclas", "digitar") and not passo.get("descricao"):
                descricao = f"{passo['acao']} {passo.get('valor', '') if passo['acao'] == 'teclas' else '(texto)'}"
            self.log(f"     {'   ' * nivel}{i:>2}. {descricao}")
            if self.simular:
                if passo.get("acao") == "se_janela":
                    self._passos(passo.get("entao", []), variaveis, nivel + 1)
                continue
            if self.passo_a_passo:
                input("        [ENTER para executar este passo] ")
            try:
                self._passo(passo, variaveis)
            except ErroRPA:
                raise
            except Exception as e:
                raise ErroRPA(f"Falha no passo {i} ({descricao}): {e}") from e
            pausa = passo.get("pausa", self.cfg.get("pausa_entre_passos", 0.5))
            time.sleep(float(pausa))

    def _passo(self, p, variaveis):
        acao = p.get("acao")
        kb = None if acao in ("esperar", "pausa_manual", "esperar_arquivo", "print") else self.pw["keyboard"]

        if acao == "abrir":
            jan = self._achar_janela(self.cfg.get("janela_principal", "Domínio"), 3)
            if jan is None:
                exe = self.cfg.get("executavel")
                if not exe:
                    raise ErroRPA("Domínio não está aberto e 'dominio.executavel' não foi configurado")
                subprocess.Popen([exe], cwd=str(Path(exe).parent))
                jan = self._achar_janela(self.cfg.get("janela_principal", "Domínio"), float(p.get("timeout", 120)))
                if jan is None:
                    raise ErroRPA("Domínio não abriu a tempo")
            self.janela = jan
            jan.set_focus()

        elif acao == "focar":
            jan = self._achar_janela(p["janela"], float(p.get("timeout", 30)))
            if jan is None:
                raise ErroRPA(f"Janela '{p['janela']}' não apareceu")
            self.janela = jan
            jan.set_focus()

        elif acao == "teclas":
            kb.send_keys(p["valor"], with_spaces=True, pause=float(p.get("intervalo", 0.05)))

        elif acao == "digitar":
            texto = str(p.get("texto", ""))
            if p.get("controle"):
                ctrl = self._controle(p["controle"])
                try:
                    ctrl.set_edit_text(texto)
                except Exception:
                    ctrl.click_input()
                    kb.send_keys("^a{BACKSPACE}" + _escapar(texto), with_spaces=True)
            else:
                kb.send_keys(_escapar(texto), with_spaces=True, pause=float(p.get("intervalo", 0.03)))

        elif acao == "clicar":
            self._controle(p["controle"]).click_input(double=bool(p.get("duplo")))

        elif acao == "menu":
            if self.janela is None:
                raise ErroRPA("Nenhuma janela em foco para abrir o menu")
            self.janela.menu_select(p["caminho"])

        elif acao == "clicar_imagem":
            try:
                import pyautogui
            except ImportError as e:
                raise ErroRPA("pyautogui não instalado (necessário para clicar_imagem)") from e
            limite = time.time() + float(p.get("timeout", 30))
            while time.time() < limite:
                try:
                    pos = pyautogui.locateCenterOnScreen(p["imagem"], confidence=float(p.get("confianca", 0.9)))
                except Exception:
                    pos = None
                if pos:
                    pyautogui.click(pos)
                    return
                time.sleep(0.5)
            raise ErroRPA(f"Imagem {p['imagem']} não encontrada na tela")

        elif acao == "esperar":
            time.sleep(float(p.get("segundos", 1)))

        elif acao == "esperar_janela":
            timeout = float(p.get("timeout", 60))
            if p.get("sumir"):
                limite = time.time() + timeout
                while time.time() < limite and self._achar_janela(p["janela"], 0.5):
                    time.sleep(1)
                if self._achar_janela(p["janela"], 0.5):
                    raise ErroRPA(f"Janela '{p['janela']}' não fechou em {timeout:.0f}s")
            elif self._achar_janela(p["janela"], timeout) is None:
                raise ErroRPA(f"Janela '{p['janela']}' não apareceu em {timeout:.0f}s")

        elif acao == "se_janela":
            jan = self._achar_janela(p["janela"], float(p.get("timeout", 3)))
            if jan is not None:
                anterior, self.janela = self.janela, jan
                jan.set_focus()
                self._passos(p.get("entao", []), variaveis, 1)
                if p.get("voltar", True):
                    self.janela = anterior

        elif acao == "esperar_arquivo":
            caminho = Path(p["caminho"])
            limite = time.time() + float(p.get("timeout", 300))
            tamanho = -1
            while time.time() < limite:
                if caminho.is_file():
                    atual = caminho.stat().st_size
                    if atual > 0 and atual == tamanho:
                        return
                    tamanho = atual
                time.sleep(2)
            raise ErroRPA(f"Arquivo {caminho} não foi gerado em {p.get('timeout', 300)}s")

        elif acao == "print":
            self.print(p.get("nome", "tela"))

        elif acao == "pausa_manual":
            input(f"        ⏸  {p.get('mensagem', 'Conclua a etapa manual')} — ENTER para continuar ")

        else:
            raise ErroRPA(f"Ação desconhecida: {acao}")

    # ------------------------------------------------------------ calibração
    def mapear(self, regex, destino):
        """Grava a árvore de controles da janela (para escrever/calibrar receitas)."""
        jan = self._achar_janela(regex, 10)
        if jan is None:
            raise ErroRPA(f"Janela '{regex}' não encontrada")
        Path(destino).parent.mkdir(parents=True, exist_ok=True)
        jan.print_control_identifiers(filename=str(destino))
        return destino


def _escapar(texto):
    """Escapa caracteres especiais do send_keys do pywinauto em textos literais."""
    return re.sub(r"([{}+^%~()])", r"{\1}", texto)
