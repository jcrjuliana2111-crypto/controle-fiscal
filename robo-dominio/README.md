# Robô de obrigações — Domínio Sistemas

Roda no Windows onde o Domínio está instalado. Para cada empresa cadastrada no painel (`obrigacoes.html`), o robô faz:

| Etapa | O que faz |
|---|---|
| **Importação** | troca de empresa no Domínio e importa os XMLs da competência (receitas `trocar_empresa` e `importar_xml`) |
| **Geração** | gera o arquivo de cada obrigação no Domínio (receitas `gerar_<obrigacao>`) |
| **Conferência** | valida o arquivo sem depender do Domínio: estrutura SPED (blocos, 9900, 9999), CNPJ, período, apuração do ICMS (E110) e do PIS/COFINS (M200/M600), e cruza o C100 com os XMLs (nota fora do SPED, valor divergente, nota cancelada escriturada) |
| **Entrega** | acha o recibo do ReceitaNet/PVA na pasta de recibos e marca como transmitida. Só transmite pelo Domínio (receitas `transmitir_<obrigacao>`) se `entrega.permitir_transmissao_automatica: true` **e** a conferência estiver sem erros |

O resultado de cada etapa aparece no painel: status, apontamentos da conferência, recibo e histórico.

## Instalação

```bat
pip install -r requirements.txt
copy config.exemplo.yaml config.yaml
setx DOMINIO_SENHA "senha-do-usuario-dominio"
```

Ajuste no `config.yaml` o executável do Domínio, as pastas de XML, saída e recibos.

## Calibração das telas

Menus, títulos e atalhos do Domínio mudam conforme a versão e a instalação. As receitas em `receitas.yaml` são **modelos** e precisam ser calibradas na sua máquina:

```bat
python -m robo_dominio mapear --janela "Domínio"            & REM lista os controles da tela aberta
python -m robo_dominio receita trocar_empresa --empresa 123 --passo-a-passo
python -m robo_dominio receita importar_xml --empresa 123 --competencia 2026-09 --passo-a-passo
python -m robo_dominio ciclo --competencia 2026-09 --simular  & REM mostra o que faria, sem clicar
```

Se o Domínio for usado por acesso remoto (Domínio Web/Terminal Server), o Windows não enxerga os campos da tela. Nesse caso use só passos `teclas`, `digitar` sem `controle` e `clicar_imagem`.

## Uso

```bat
python -m robo_dominio ciclo                                   & REM competência anterior, todas as empresas
python -m robo_dominio ciclo --competencia 2026-09 --empresa 123
python -m robo_dominio ciclo --competencia 2026-09 --etapas conferir,entregar
python -m robo_dominio conferir --tipo sped_fiscal --arquivo SPED.txt --cnpj 12345678000199 --competencia 2026-09 --xml D:\XML\123\202609
```

Para rodar automaticamente, agende o `executar_robo.bat` no Agendador de Tarefas. A sessão do Windows precisa estar logada e desbloqueada.

## Testes

```bash
python -m unittest discover -s tests
```
