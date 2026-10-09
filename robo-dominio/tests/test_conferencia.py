import json
import tempfile
import unittest
from collections import Counter
from pathlib import Path

from robo_dominio import conferencia, recibos
from robo_dominio.ciclo import Ciclo
from robo_dominio.painel import PainelLocal
from robo_dominio.rpa import Robo

CNPJ = "12345678000199"
CNPJ_FORN = "99888777000166"
CH_SAIDA = "35260912345678000199550010000001231000001230"
CH_SAIDA2 = "35260912345678000199550010000001241000001241"
CH_ENTRADA = "35260999888777000166550010000005551000005551"


def montar_sped(corpo, abertura=None):
    """Monta um SPED com blocos de encerramento e bloco 9 consistentes."""
    abertura = abertura or f"|0000|019|0|01092026|30092026|EMPRESA EXEMPLO LTDA|{CNPJ}||SP|123456789||3550308||A|1|"
    linhas = [abertura, "|0001|0|"] + corpo
    blocos = []
    for l in linhas:
        b = l[1]
        if b not in blocos:
            blocos.append(b)
    final = []
    for b in blocos:
        do_bloco = [l for l in linhas if l[1] == b]
        final += do_bloco + [f"|{b}990|{len(do_bloco) + 1}|"]
    regs = Counter(l.split("|")[1] for l in final)
    regs.update(["9001", "9990", "9999"])
    tipos = sorted(regs) + ["9900"]
    regs["9900"] = len(tipos)
    bloco9 = ["|9001|0|"] + [f"|9900|{r}|{regs[r]}|" for r in tipos]
    bloco9 += [f"|9990|{len(bloco9) + 2}|"]
    total = len(final) + len(bloco9) + 1
    return "\n".join(final + bloco9 + [f"|9999|{total}|"]) + "\n"


CORPO_FISCAL = [
    "|C001|0|",
    f"|C100|1|0|CLI1|55|00|1|123|{CH_SAIDA}|10092026|10092026|1000,00|0|0|0|1000,00|0|0|0|0|1000,00|180,00|0|0|0|0|0|0|0|",
    "|C190|000|5102|18,00|1000,00|1000,00|180,00|0|0|0|0||",
    f"|C100|0|1|FORN|55|00|1|555|{CH_ENTRADA}|05092026|06092026|500,00|0|0|0|500,00|0|0|0|0|500,00|60,00|0|0|0|0|0|0|0|",
    "|C190|000|1102|12,00|500,00|500,00|60,00|0|0|0|0||",
    "|E001|0|",
    "|E100|01092026|30092026|",
    "|E110|180,00|0|0|0|60,00|0|0|0|0|120,00|0|120,00|0|0|",
]


def nfe_xml(chave, emit, dest, valor, data="2026-09-10", cstat="100", numero="123"):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
 <NFe><infNFe Id="NFe{chave}" versao="4.00">
  <ide><mod>55</mod><nNF>{numero}</nNF><dhEmi>{data}T10:00:00-03:00</dhEmi><tpNF>1</tpNF></ide>
  <emit><CNPJ>{emit}</CNPJ></emit><dest><CNPJ>{dest}</CNPJ></dest>
  <total><ICMSTot><vICMS>0</vICMS><vNF>{valor}</vNF></ICMSTot></total>
 </infNFe></NFe>
 <protNFe><infProt><chNFe>{chave}</chNFe><cStat>{cstat}</cStat></infProt></protNFe>
</nfeProc>"""


def evento_cancelamento(chave):
    return f"""<procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe"><evento><infEvento>
<chNFe>{chave}</chNFe><tpEvento>110111</tpEvento></infEvento></evento></procEventoNFe>"""


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def escrever(self, nome, conteudo):
        p = self.dir / nome
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(conteudo, encoding="latin-1")
        return p

    def codigos(self, res, nivel=None):
        return [a["codigo"] for a in res.apontamentos if nivel is None or a["nivel"] == nivel]


class TestSpedFiscal(Base):
    def test_arquivo_consistente_sem_erros(self):
        arq = self.escrever("sped.txt", montar_sped(CORPO_FISCAL))
        res = conferencia.conferir("sped_fiscal", arq, CNPJ, "2026-09")
        self.assertEqual(res.erros, [], res.apontamentos)
        self.assertEqual(self.codigos(res, "alerta"), [])
        self.assertEqual(str(res.resumo["icms_a_recolher"]), "120.00")

    def test_assinatura_digital_apos_9999_e_ignorada(self):
        arq = self.dir / "assinado.txt"
        arq.write_bytes(montar_sped(CORPO_FISCAL).encode("latin-1") + b"SBRCAAEPDR\x00\x01\xff lixo binario")
        self.assertTrue(conferencia.conferir("sped_fiscal", arq, CNPJ, "2026-09").ok)

    def test_cnpj_e_periodo_errados(self):
        arq = self.escrever("sped.txt", montar_sped(CORPO_FISCAL))
        res = conferencia.conferir("sped_fiscal", arq, "11111111000111", "2026-08")
        self.assertIn("CNPJ", self.codigos(res, "erro"))
        self.assertIn("PERIODO", self.codigos(res, "erro"))

    def test_contagens_inconsistentes(self):
        texto = montar_sped(CORPO_FISCAL).replace("|C190|000|1102|12,00|500,00|500,00|60,00|0|0|0|0||\n", "")
        res = conferencia.conferir("sped_fiscal", self.escrever("sped.txt", texto), CNPJ, "2026-09")
        codigos = self.codigos(res, "erro")
        self.assertIn("QTD_LINHAS", codigos)
        self.assertIn("9900", codigos)
        self.assertIn("QTD_BLOCO", codigos)

    def test_apuracao_errada(self):
        corpo = CORPO_FISCAL[:-1] + ["|E110|180,00|0|0|0|60,00|0|0|0|0|100,00|0|100,00|0|0|"]
        res = conferencia.conferir("sped_fiscal", self.escrever("sped.txt", montar_sped(corpo)), CNPJ, "2026-09")
        self.assertIn("E110_SALDO", self.codigos(res, "erro"))

    def test_debitos_documentos_divergentes_geram_alerta(self):
        corpo = CORPO_FISCAL[:-1] + ["|E110|200,00|0|0|0|60,00|0|0|0|0|140,00|0|140,00|0|0|"]
        res = conferencia.conferir("sped_fiscal", self.escrever("sped.txt", montar_sped(corpo)), CNPJ, "2026-09")
        self.assertTrue(res.ok)
        self.assertIn("DEBITOS_DOCS", self.codigos(res, "alerta"))

    def test_arquivo_ausente(self):
        res = conferencia.conferir("sped_fiscal", self.dir / "nao_existe.txt", CNPJ, "2026-09")
        self.assertEqual(self.codigos(res), ["ARQUIVO_AUSENTE"])


class TestCruzamentoXml(Base):
    def test_cruzamento(self):
        arq = self.escrever("sped.txt", montar_sped(CORPO_FISCAL))
        xml = self.dir / "xml"
        # saída escriturada com valor divergente
        self.escrever("xml/saida.xml", nfe_xml(CH_SAIDA, CNPJ, CNPJ_FORN, "1100.00"))
        # saída autorizada que não está no SPED
        self.escrever("xml/saida2.xml", nfe_xml(CH_SAIDA2, CNPJ, CNPJ_FORN, "50.00", numero="124"))
        # entrada escriturada e conferindo
        self.escrever("xml/entrada.xml", nfe_xml(CH_ENTRADA, CNPJ_FORN, CNPJ, "500.00", numero="555"))
        res = conferencia.conferir("sped_fiscal", arq, CNPJ, "2026-09", pasta_xml=xml)
        erros = self.codigos(res, "erro")
        self.assertIn("VALOR_NFE", erros)
        self.assertIn("NFE_NAO_ESCRITURADA", erros)
        self.assertEqual(res.resumo["xml_proprias"], 2)
        self.assertEqual(res.resumo["xml_terceiros"], 1)

    def test_cancelada_escriturada_como_regular(self):
        arq = self.escrever("sped.txt", montar_sped(CORPO_FISCAL))
        self.escrever("xml/saida.xml", nfe_xml(CH_SAIDA, CNPJ, CNPJ_FORN, "1000.00"))
        self.escrever("xml/canc.xml", evento_cancelamento(CH_SAIDA))
        res = conferencia.conferir("sped_fiscal", arq, CNPJ, "2026-09", pasta_xml=self.dir / "xml")
        self.assertIn("CANCELADA_ATIVA", self.codigos(res, "erro"))

    def test_sem_xml_gera_alerta(self):
        arq = self.escrever("sped.txt", montar_sped(CORPO_FISCAL))
        res = conferencia.conferir("sped_fiscal", arq, CNPJ, "2026-09", pasta_xml=self.dir / "vazia")
        self.assertTrue(res.ok)
        self.assertIn("SEM_XML", self.codigos(res, "alerta"))


class TestContribuicoes(Base):
    ABERTURA = f"|0000|006|0|||01092026|30092026|EMPRESA EXEMPLO LTDA|{CNPJ}|SP|3550308||00|0|"

    def corpo(self, m200):
        return ["|M001|0|", m200, "|M600|1000,00|400,00|0|600,00|0|0|600,00|0|0|0|0|600,00|"]

    def test_apuracao_ok(self):
        texto = montar_sped(self.corpo("|M200|165,00|65,00|0|100,00|0|0|100,00|0|0|0|0|100,00|"), self.ABERTURA)
        res = conferencia.conferir("sped_contrib", self.escrever("c.txt", texto), CNPJ, "2026-09")
        self.assertEqual(res.erros, [], res.apontamentos)
        self.assertEqual(str(res.resumo["pis_a_recolher"]), "100.00")

    def test_apuracao_errada(self):
        texto = montar_sped(self.corpo("|M200|165,00|65,00|0|100,00|0|0|90,00|0|0|0|0|90,00|"), self.ABERTURA)
        res = conferencia.conferir("sped_contrib", self.escrever("c.txt", texto), CNPJ, "2026-09")
        self.assertIn("M200_NC_REC", self.codigos(res, "erro"))


class TestRecibos(Base):
    def test_localiza_recibo_por_cnpj_e_periodo(self):
        self.escrever("rec/outro.REC", f"CNPJ 11111111000111 periodo 01092026 AA.BB.CC.DD.EE.FF.00")
        self.escrever("rec/certo.REC", f"CNPJ {CNPJ} periodo 01092026 recibo 1A.2B.3C.4D.5E.6F.70-81.92.A3.B4.C5.D6")
        self.escrever("rec/mes_errado.REC", f"CNPJ {CNPJ} periodo 01082026")
        rec = recibos.localizar([self.dir / "rec"], CNPJ, "2026-09")
        self.assertTrue(rec["arquivo"].endswith("certo.REC"))
        self.assertEqual(rec["numero"], "1A.2B.3C.4D.5E.6F.70-81.92.A3.B4.C5.D6")

    def test_sem_recibo(self):
        self.assertIsNone(recibos.localizar([self.dir / "nada"], CNPJ, "2026-09"))


class TestCiclo(Base):
    def test_ciclo_sem_painel_confere_e_reconhece_recibo(self):
        saida = self.dir / "saida" / "${obrigacao}"
        self.escrever(f"saida/EFD_ICMS_IPI/EFD_ICMS_IPI_{CNPJ}_202609.txt", montar_sped(CORPO_FISCAL))
        self.escrever("recibos/r.REC", f"{CNPJ} 01092026 1A.2B.3C.4D.5E.6F.70")
        cfg = {
            "painel": {}, "dominio": {}, "entrega": {}, "obrigacoes": {}, "_receitas": {}, "_base": self.dir,
            "pastas": {"saida": str(saida), "recibos": {"EFD_ICMS_IPI": [str(self.dir / "recibos")]}},
        }
        empresas = [{"id": "1", "codigo_dominio": 1, "cnpj": CNPJ, "razao": "X",
                     "obrigacoes": ["EFD_ICMS_IPI", "DCTFWEB"], "ativo": True}]
        painel = PainelLocal(self.dir / "dados.json", empresas)
        robo = Robo({}, {}, self.dir / "evid")
        resumo = Ciclo(cfg, painel, robo, log=lambda *_: None).executar("2026-09", etapas=("conferir", "entregar"))
        self.assertEqual(resumo["conferidas"], 1)
        self.assertEqual(resumo["transmitidas"], 1)
        dados = json.loads((self.dir / "dados.json").read_text("utf-8"))
        efd = dados["1|EFD_ICMS_IPI|2026-09"]
        self.assertEqual(efd["status"], "transmitido")
        self.assertEqual(efd["recibo"], "1A.2B.3C.4D.5E.6F.70")
        self.assertTrue(efd["conferencia"]["ok"])
        self.assertNotIn("1|DCTFWEB|2026-09", dados)  # manual e sem arquivo: nada a registrar


if __name__ == "__main__":
    unittest.main()
