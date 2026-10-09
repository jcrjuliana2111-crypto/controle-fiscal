// Catálogo de serviços da API Integra Contador (SERPRO).
// Cada serviço: sistema/serviço/versão oficiais, o método HTTP (Consultar,
// Emitir, Declarar, Monitorar, Apoiar), os campos que formam o "dados" e
// textos para a tela. Serviços com estrutura extensa (declarações completas)
// recebem o JSON pronto, a partir de um modelo.

const P = (nome, rotulo, extra = {}) => ({ nome, rotulo, tipo: 'texto', obrigatorio: true, ...extra });
const periodo = (nome = 'periodoApuracao', rotulo = 'Período de apuração', extra = {}) => P(nome, rotulo, { tipo: 'periodo', ...extra });
const ano = (nome = 'anoCalendario', rotulo = 'Ano-calendário', extra = {}) => P(nome, rotulo, { tipo: 'ano', ...extra });
const opcional = (campo) => ({ ...campo, obrigatorio: false });

const S = (sistema, servico, versao, tipo, grupo, nome, descricao, campos = [], extra = {}) => ({
  codigo: `${sistema}.${servico}`, sistema, servico, versao, tipo, grupo, nome, descricao, campos, ...extra,
});

// Parcelamentos seguem o mesmo padrão; o sufixo numérico muda por sistema.
function parcelamento(sistema, base, grupo, rotulo) {
  return [
    S(sistema, `PEDIDOSPARC${base + 3}`, '1.0', 'Consultar', grupo, `${rotulo}: pedidos`, 'Lista os pedidos de parcelamento do contribuinte.'),
    S(sistema, `OBTERPARC${base + 4}`, '1.0', 'Consultar', grupo, `${rotulo}: consultar parcelamento`, 'Detalhes de um parcelamento (situação, valores, parcelas).',
      [P('numeroParcelamento', 'Número do parcelamento', { tipo: 'numero' })]),
    S(sistema, `PARCELASPARAGERAR${base + 2}`, '1.0', 'Consultar', grupo, `${rotulo}: parcelas disponíveis`, 'Parcelas que podem ser emitidas agora.'),
    S(sistema, `DETPAGTOPARC${base + 5}`, '1.0', 'Consultar', grupo, `${rotulo}: pagamento de parcela`, 'Detalhes do pagamento de uma parcela.',
      [P('numeroParcelamento', 'Número do parcelamento', { tipo: 'numero' }), periodo('anoMesParcela', 'Mês da parcela', { tipo: 'periodo', numerico: true })]),
    S(sistema, `GERARDAS${base + 1}`, '1.0', 'Emitir', grupo, `${rotulo}: emitir DAS da parcela`, 'Gera o DAS (PDF) de uma parcela.',
      [periodo('parcelaParaEmitir', 'Parcela (mês)', { numerico: true })], {}),
  ];
}

export const CATALOGO = [
  // ------------------------------------------------------------ MEI
  S('PGMEI', 'GERARDASPDF21', '1.0', 'Emitir', 'MEI', 'DAS do MEI (PDF)', 'Gera a guia mensal do MEI em PDF, com código de barras e Pix.',
    [periodo(), opcional(P('dataConsolidacao', 'Pagar em (data de consolidação)', { tipo: 'data8' }))], { destaque: true }),
  S('PGMEI', 'GERARDASCODBARRA22', '1.0', 'Emitir', 'MEI', 'DAS do MEI (só código de barras)', 'Gera a guia do MEI apenas com a linha digitável, sem PDF.',
    [periodo(), opcional(P('dataConsolidacao', 'Pagar em', { tipo: 'data8' }))]),
  S('PGMEI', 'ATUBENEFICIO23', '1.0', 'Emitir', 'MEI', 'Registrar benefício (auxílio) no DAS', 'Informa meses em que o MEI recebeu benefício previdenciário.',
    [], { modeloJson: { anoCalendario: 2026, infoBeneficio: [{ periodoApuracao: '202601', indicadorBeneficio: true }] } }),
  S('PGMEI', 'DIVIDAATIVA24', '1.0', 'Consultar', 'MEI', 'Dívida ativa do MEI', 'Consulta débitos do MEI inscritos em dívida ativa.', [ano()]),
  S('CCMEI', 'EMITIRCCMEI121', '1.0', 'Emitir', 'MEI', 'Certificado do MEI (CCMEI)', 'Emite o Certificado da Condição de Microempreendedor Individual em PDF.'),
  S('CCMEI', 'DADOSCCMEI122', '1.0', 'Consultar', 'MEI', 'Dados cadastrais do MEI', 'Dados do CCMEI: nome, endereço, atividades, situação.'),
  S('CCMEI', 'CCMEISITCADASTRAL123', '1.0', 'Consultar', 'MEI', 'Situação cadastral do MEI', 'Indica se o CNPJ está enquadrado como MEI.'),
  S('DASNSIMEI', 'TRANSDECLARACAO151', '1.0', 'Declarar', 'MEI', 'Declaração anual do MEI (DASN-SIMEI)', 'Transmite a declaração anual de faturamento do MEI.',
    [], { modeloJson: { anoCalendario: 2025, receitaBrutaTotal: 0, receitaBrutaComercio: 0, receitaBrutaServico: 0, possuiEmpregado: false } }),
  S('DASNSIMEI', 'CONSULTIMADECREC152', '1.0', 'Consultar', 'MEI', 'Última declaração anual do MEI', 'Recibo e situação da última DASN-SIMEI do ano.', [ano()]),

  // ------------------------------------------------------------ Simples Nacional
  S('PGDASD', 'TRANSDECLARACAO11', '1.0', 'Declarar', 'Simples Nacional', 'Entregar PGDAS-D', 'Transmite a declaração mensal do Simples Nacional.',
    [], { modeloJson: { cnpjCompleto: '00000000000000', pa: 202609, indicadorTransmissao: true, indicadorComparacao: false,
      declaracao: { tipoDeclaracao: 1, receitaPaCompetenciaInterno: 0, receitaPaCompetenciaExterno: 0, estabelecimentos: [] } } }),
  S('PGDASD', 'GERARDAS12', '1.0', 'Emitir', 'Simples Nacional', 'DAS do Simples Nacional', 'Gera o DAS do período já declarado.',
    [periodo(), opcional(P('dataConsolidacao', 'Pagar em', { tipo: 'data8' }))], { destaque: true }),
  S('PGDASD', 'CONSDECLARACAO13', '1.0', 'Consultar', 'Simples Nacional', 'Declarações entregues', 'Lista as declarações PGDAS-D de um ano (ou de um período).',
    [ano('anoCalendario', 'Ano-calendário')]),
  S('PGDASD', 'CONSULTIMADECREC14', '1.0', 'Consultar', 'Simples Nacional', 'Última declaração e recibo', 'Declaração e recibo mais recentes de um período, em PDF.', [periodo()]),
  S('PGDASD', 'CONSDECREC15', '1.0', 'Consultar', 'Simples Nacional', 'Declaração por número', 'Declaração e recibo a partir do número da declaração.',
    [P('numeroDeclaracao', 'Número da declaração (17 dígitos)')]),
  S('PGDASD', 'CONSEXTRATO16', '1.0', 'Consultar', 'Simples Nacional', 'Extrato do DAS', 'Extrato detalhado (apuração por tributo) de um DAS.',
    [P('numeroDas', 'Número do DAS (17 dígitos)')]),
  S('PGDASD', 'GERARDASCOBRANCA17', '1.0', 'Emitir', 'Simples Nacional', 'DAS de cobrança', 'DAS de débitos em cobrança na Receita.', [periodo()]),
  S('PGDASD', 'GERARDASPROCESSO18', '1.0', 'Emitir', 'Simples Nacional', 'DAS de processo', 'DAS vinculado a um processo administrativo.', [P('numeroProcesso', 'Número do processo')]),
  S('PGDASD', 'GERARDASAVULSO19', '1.0', 'Emitir', 'Simples Nacional', 'DAS avulso', 'DAS com tributos e valores informados manualmente.',
    [], { modeloJson: { periodoApuracao: '202609', listaTributos: [{ codigo: 1001, valor: 100.0 }] } }),
  S('REGIMEAPURACAO', 'EFETUAROPCAOREGIME101', '1.0', 'Declarar', 'Simples Nacional', 'Opção pelo regime de apuração', 'Escolhe regime de competência ou de caixa para o ano.',
    [P('anoOpcao', 'Ano da opção', { tipo: 'ano', numerico: true }),
      P('tipoRegime', 'Regime', { tipo: 'select', opcoes: [['0', 'Competência'], ['1', 'Caixa']], numerico: true }),
      P('descritivoRegime', 'Descrição', { valorPadrao: 'COMPETENCIA' }),
      P('deAcordoResolucao', 'Concordo com a resolução', { tipo: 'select', opcoes: [['true', 'Sim']], booleano: true })]),
  S('REGIMEAPURACAO', 'CONSULTARANOSCALENDARIOS102', '1.0', 'Consultar', 'Simples Nacional', 'Anos com opção de regime', 'Lista os anos em que houve opção de regime.'),
  S('REGIMEAPURACAO', 'CONSULTAROPCAOREGIME103', '1.0', 'Consultar', 'Simples Nacional', 'Regime de apuração do ano', 'Mostra o regime escolhido para o ano.', [ano('anoCalendario', 'Ano', { numerico: true })]),
  S('REGIMEAPURACAO', 'CONSULTARRESOLUCAO104', '1.0', 'Consultar', 'Simples Nacional', 'Resolução do regime de caixa', 'Texto da resolução para o regime de caixa.', [ano('anoCalendario', 'Ano', { numerico: true })]),
  S('DEFIS', 'TRANSDECLARACAO141', '1.0', 'Declarar', 'Simples Nacional', 'Entregar DEFIS', 'Transmite a declaração anual DEFIS.',
    [], { modeloJson: { ano: 2025, inatividade: 2, empresa: { ganhoCapital: 0, qtdEmpregadoInicial: 0, qtdEmpregadoFinal: 0, socios: [], estabelecimentos: [] } } }),
  S('DEFIS', 'CONSDECLARACAO142', '1.0', 'Consultar', 'Simples Nacional', 'DEFIS entregues', 'Lista as DEFIS transmitidas.'),
  S('DEFIS', 'CONSULTIMADECREC143', '1.0', 'Consultar', 'Simples Nacional', 'Última DEFIS do ano', 'Declaração e recibo da última DEFIS do ano.', [ano('ano', 'Ano', { numerico: true })]),
  S('DEFIS', 'CONSDECREC144', '1.0', 'Consultar', 'Simples Nacional', 'DEFIS específica', 'Declaração e recibo de uma DEFIS pelo identificador.', [P('idDefis', 'Identificador da DEFIS')]),

  // ------------------------------------------------------------ Parcelamentos
  ...parcelamento('PARCSN', 160, 'Parcelamentos', 'Parcelamento SN'),
  ...parcelamento('PARCSN-ESP', 170, 'Parcelamentos', 'Parcelamento SN especial'),
  ...parcelamento('PERTSN', 180, 'Parcelamentos', 'PERT-SN'),
  ...parcelamento('RELPSN', 190, 'Parcelamentos', 'RELP-SN'),
  ...parcelamento('PARCMEI', 200, 'Parcelamentos', 'Parcelamento MEI'),
  ...parcelamento('PARCMEI-ESP', 210, 'Parcelamentos', 'Parcelamento MEI especial'),
  ...parcelamento('PERTMEI', 220, 'Parcelamentos', 'PERT-MEI'),
  ...parcelamento('RELPMEI', 230, 'Parcelamentos', 'RELP-MEI'),

  // ------------------------------------------------------------ Situação fiscal e comunicação
  S('SITFIS', 'SOLICITARPROTOCOLO91', '1.0', 'Apoiar', 'Situação fiscal', 'Pedir relatório de situação fiscal', 'Primeiro passo: gera o protocolo do relatório.', [], { interno: true }),
  S('SITFIS', 'RELATORIOSITFIS92', '1.0', 'Emitir', 'Situação fiscal', 'Relatório de situação fiscal (PDF)', 'Relatório completo de pendências na Receita e na PGFN.',
    [], { composto: 'sitfis', destaque: true }),
  S('CAIXAPOSTAL', 'MSGCONTRIBUINTE61', '1.0', 'Consultar', 'Situação fiscal', 'Mensagens da Caixa Postal (e-CAC)', 'Lista as mensagens enviadas pela Receita ao contribuinte.',
    [P('statusLeitura', 'Mensagens', { tipo: 'select', opcoes: [['0', 'Todas'], ['2', 'Não lidas'], ['1', 'Lidas']], numerico: true, valorPadrao: '0' }),
      P('indicadorPagina', 'Página', { tipo: 'select', opcoes: [['0', 'Mais recentes']], numerico: true, valorPadrao: '0' })]),
  S('CAIXAPOSTAL', 'MSGDETALHAMENTO62', '1.0', 'Consultar', 'Situação fiscal', 'Abrir mensagem da Caixa Postal', 'Conteúdo completo de uma mensagem.', [P('isn', 'Identificador da mensagem (ISN)')]),
  S('CAIXAPOSTAL', 'INNOVAMSG63', '1.0', 'Monitorar', 'Situação fiscal', 'Há mensagens novas?', 'Indica se existem mensagens novas na Caixa Postal.'),
  S('DTE', 'CONSULTASITUACAODTE111', '1.0', 'Consultar', 'Situação fiscal', 'Domicílio Tributário Eletrônico (DTE)', 'Situação de adesão ao DTE.'),
  S('PROCURACOES', 'OBTERPROCURACAO41', '1', 'Consultar', 'Situação fiscal', 'Procurações eletrônicas', 'Procurações entre o contribuinte e o seu escritório.', [], { composto: 'procuracao' }),

  // ------------------------------------------------------------ Federais
  S('DCTFWEB', 'GERARGUIA31', '1.0', 'Emitir', 'DCTFWeb e MIT', 'DARF da DCTFWeb', 'Gera o DARF da declaração DCTFWeb do período.', camposDctf(), { destaque: true }),
  S('DCTFWEB', 'GERARGUIAANDAMENTO313', '1.0', 'Emitir', 'DCTFWeb e MIT', 'DARF da DCTFWeb em andamento', 'DARF de declaração ainda não transmitida.', camposDctf()),
  S('DCTFWEB', 'CONSRECIBO32', '1.0', 'Consultar', 'DCTFWeb e MIT', 'Recibo da DCTFWeb', 'Recibo de transmissão em PDF.', camposDctf()),
  S('DCTFWEB', 'CONSDECCOMPLETA33', '1.0', 'Consultar', 'DCTFWeb e MIT', 'Declaração DCTFWeb completa', 'Relatório completo da declaração em PDF.', camposDctf()),
  S('DCTFWEB', 'CONSXMLDECLARACAO38', '1.0', 'Consultar', 'DCTFWeb e MIT', 'XML da DCTFWeb', 'XML da declaração transmitida.', camposDctf()),
  S('DCTFWEB', 'TRANSDECLARACAO310', '1.0', 'Declarar', 'DCTFWeb e MIT', 'Transmitir DCTFWeb', 'Transmite a declaração (XML assinado em Base64).',
    [], { modeloJson: { categoria: 'GERAL_MENSAL', anoPA: '2026', mesPA: '09', xmlAssinadoBase64: '' } }),
  S('MIT', 'ENCAPURACAO314', '1.0', 'Declarar', 'DCTFWeb e MIT', 'Encerrar apuração MIT', 'Encerra a apuração do Módulo de Inclusão de Tributos.',
    [], { modeloJson: { PeriodoApuracao: { MesApuracao: 9, AnoApuracao: 2026 }, DadosIniciais: { SemMovimento: true, QualificacaoPj: 1, ResponsavelApuracao: { CpfResponsavel: '00000000000' } } } }),
  S('MIT', 'SITUACAOENC315', '1.0', 'Apoiar', 'DCTFWeb e MIT', 'Situação do encerramento MIT', 'Acompanha o processamento do encerramento.', [P('protocoloEncerramento', 'Protocolo')]),
  S('MIT', 'CONSAPURACAO316', '1.0', 'Consultar', 'DCTFWeb e MIT', 'Consultar apuração MIT', 'Detalhes de uma apuração.', [P('idApuracao', 'Identificador da apuração', { tipo: 'numero' })]),
  S('MIT', 'LISTAAPURACOES317', '1.0', 'Consultar', 'DCTFWeb e MIT', 'Listar apurações MIT', 'Apurações do ano.', [P('anoApuracao', 'Ano', { tipo: 'ano', numerico: true }), opcional(P('mesApuracao', 'Mês', { tipo: 'numero' }))]),
  S('SICALC', 'CONSOLIDARGERARDARF51', '2.9', 'Emitir', 'DARF e pagamentos', 'Calcular e emitir DARF', 'Calcula multa e juros e emite o DARF em PDF.',
    [], { modeloJson: { uf: 'SP', municipio: 6291, codigoReceita: '0190', codigoReceitaExtensao: '01', tipoPA: 'ME', dataPA: '09/2026', vencimento: '2026-10-31', valorImposto: 100.0, dataConsolidacao: '2026-10-31' } }),
  S('SICALC', 'GERARDARFCODBARRA53', '2.9', 'Emitir', 'DARF e pagamentos', 'DARF só com código de barras', 'Calcula e devolve a linha digitável do DARF.',
    [], { modeloJson: { uf: 'SP', municipio: 6291, codigoReceita: '0190', codigoReceitaExtensao: '01', tipoPA: 'ME', dataPA: '09/2026', vencimento: '2026-10-31', valorImposto: 100.0, dataConsolidacao: '2026-10-31' } }),
  S('SICALC', 'CONSULTAAPOIORECEITAS52', '2.9', 'Apoiar', 'DARF e pagamentos', 'Códigos de receita (DARF)', 'Regras e campos exigidos por um código de receita.', [P('codigoReceita', 'Código de receita')]),
  S('PAGTOWEB', 'PAGAMENTOS71', '1.0', 'Consultar', 'DARF e pagamentos', 'Pagamentos realizados', 'Lista DARF/DAS/GPS pagos num intervalo de datas.',
    [], { modeloJson: { intervaloDataArrecadacao: { dataInicial: '2026-01-01', dataFinal: '2026-09-30' }, primeiroDaPagina: 0, tamanhoDaPagina: 100 } }),
  S('PAGTOWEB', 'CONTACONSDOCARRPG73', '1.0', 'Consultar', 'DARF e pagamentos', 'Quantidade de pagamentos', 'Conta os pagamentos que atendem ao filtro.',
    [], { modeloJson: { intervaloDataArrecadacao: { dataInicial: '2026-01-01', dataFinal: '2026-09-30' } } }),
  S('PAGTOWEB', 'COMPARRECADACAO72', '1.0', 'Emitir', 'DARF e pagamentos', 'Comprovante de pagamento', 'Comprovante de arrecadação em PDF.', [P('numeroDocumento', 'Número do documento')]),

  // ------------------------------------------------------------ Monitoramento
  S('EVENTOSATUALIZACAO', 'SOLICEVENTOSPJ132', '1.0', 'Monitorar', 'Monitoramento', 'Monitorar atualizações (PJ)', 'Pede à Receita os eventos de atualização de uma lista de CNPJs.',
    [], { modeloJson: { cnpjs: ['00000000000000'], evento: 'E0301' } }),
  S('EVENTOSATUALIZACAO', 'OBTEREVENTOSPJ134', '1.0', 'Monitorar', 'Monitoramento', 'Resultado do monitoramento (PJ)', 'Busca o resultado de um pedido de eventos.',
    [P('protocolo', 'Protocolo'), P('evento', 'Evento', { valorPadrao: 'E0301' })]),
  S('EVENTOSATUALIZACAO', 'SOLICEVENTOSPF131', '1.0', 'Monitorar', 'Monitoramento', 'Monitorar atualizações (PF)', 'Pede os eventos de atualização de uma lista de CPFs.',
    [], { modeloJson: { cpfs: ['00000000000'], evento: 'E0301' } }),
  S('EVENTOSATUALIZACAO', 'OBTEREVENTOSPF133', '1.0', 'Monitorar', 'Monitoramento', 'Resultado do monitoramento (PF)', 'Busca o resultado de um pedido de eventos.',
    [P('protocolo', 'Protocolo'), P('evento', 'Evento', { valorPadrao: 'E0301' })]),
];

function camposDctf() {
  return [
    P('categoria', 'Categoria', { tipo: 'select', valorPadrao: 'GERAL_MENSAL', opcoes: [
      ['GERAL_MENSAL', 'Geral mensal'], ['GERAL_13o_SALARIO', '13º salário'], ['ESPETACULO_DESPORTIVO', 'Espetáculo desportivo'],
      ['AFERICAO', 'Aferição'], ['RECLAMATORIA_TRABALHISTA', 'Reclamatória trabalhista'], ['PF_MENSAL', 'Pessoa física mensal'], ['PF_13o_SALARIO', 'Pessoa física 13º']] }),
    P('anoPA', 'Ano', { tipo: 'ano' }),
    opcional(P('mesPA', 'Mês (2 dígitos)', { tipo: 'mes' })),
    opcional(P('numeroReciboEntrega', 'Número do recibo')),
  ];
}

// Custo por requisição (1ª faixa do contrato). Apoiar/Monitorar entram como consulta (estimativa).
export const CATEGORIA_CUSTO = { Consultar: 'consulta', Monitorar: 'consulta', Apoiar: 'consulta', Emitir: 'emissao', Declarar: 'declaracao' };
export const PRECO_FAIXA1 = { consulta: 0.24, emissao: 0.32, declaracao: 0.40 };

const porCodigo = new Map(CATALOGO.map((s) => [s.codigo, s]));
export function servico(codigo) {
  return porCodigo.get(codigo) || null;
}

export function catalogoPublico() {
  return CATALOGO.filter((s) => !s.interno).map(({ codigo, sistema, servico: sv, tipo, grupo, nome, descricao, campos, modeloJson, destaque, composto }) =>
    ({ codigo, sistema, servico: sv, tipo, grupo, nome, descricao, campos, modeloJson, destaque: !!destaque, composto: composto || null, custo: CATEGORIA_CUSTO[tipo] }));
}

/** Monta a string "dados" a partir dos valores digitados (ou do JSON avançado). */
export function montarDados(s, valores = {}, jsonAvancado) {
  if (s.modeloJson) {
    const obj = typeof jsonAvancado === 'string' ? JSON.parse(jsonAvancado || '{}') : (jsonAvancado || valores);
    return JSON.stringify(obj);
  }
  if (!s.campos.length) return '';
  const obj = {};
  for (const c of s.campos) {
    let v = valores[c.nome] ?? c.valorPadrao;
    if (v === undefined || v === null || v === '') {
      if (c.obrigatorio) throw new Error(`Informe: ${c.rotulo}.`);
      continue;
    }
    v = String(v).trim();
    if (c.tipo === 'periodo' && !/^\d{6}$/.test(v.replace(/\D/g, ''))) throw new Error(`${c.rotulo}: use o formato AAAAMM.`);
    if (c.tipo === 'periodo') v = v.replace(/\D/g, '');
    if (c.tipo === 'ano' && !/^\d{4}$/.test(v)) throw new Error(`${c.rotulo}: informe o ano com 4 dígitos.`);
    if (c.tipo === 'data8') { v = v.replace(/\D/g, ''); if (!/^\d{8}$/.test(v)) throw new Error(`${c.rotulo}: use AAAAMMDD.`); }
    if (c.tipo === 'mes') v = v.padStart(2, '0');
    obj[c.nome] = c.booleano ? v === 'true' : (c.numerico || c.tipo === 'numero') ? Number(v) : v;
  }
  return JSON.stringify(obj);
}
