export type CustomLogsMessages = {
  title: string;
  source: string;
  refresh: string;
  openInEditor: string;
  openInEditorTitle: string;
  configure: string;
  configureTitle: string;
  loadMore: string;
  loading: string;
  noRows: string;
  noMatch: string;
  noMatchMore: string;
  filter: {
    placeholder: string;
    aria: string;
    serverChip: string;
    loadedChip: string;
    sourceChip: string;
    removeChip: string;
    editChip: string;
    stageField: string;
    stageOperator: string;
    stageValue: string;
    stageCommit: string;
    noSuggestions: string;
    serverBadge: string;
    inColumns: string;
    rowsCount: string;
    rowCountOne: string;
  };
  errors: {
    at: string;
    expectedField: string;
    expectedOperator: string;
    expectedValue: string;
    unterminatedString: string;
    unsupportedOr: string;
    expectedAnd: string;
    expectedConditionAfterAnd: string;
    serverOperator: string;
    serverLevel: string;
    serverSince: string;
    serverSource: string;
    serverUnsupported: string;
  };
  columns: {
    time: string;
    level: string;
    title: string;
    user: string;
    counts: string;
    entries: string;
    errors: string;
    warnings: string;
  };
  table: {
    aria: string;
    addField: string;
    addFieldTitle: string;
    columnMenu: string;
    sortedAscending: string;
    sortedDescending: string;
    fromProject: string;
    payloadColumn: string;
  };
  menu: {
    sortAscending: string;
    sortDescending: string;
    filterBy: string;
    remove: string;
    hide: string;
  };
  picker: {
    title: string;
    search: string;
    empty: string;
    typeString: string;
    typeNumber: string;
    typeBoolean: string;
    typeMixed: string;
    typeNull: string;
  };
  payload: {
    title: string;
    invalid: string;
    text: string;
    empty: string;
    hidden: string;
    invalidNote: string;
    textNote: string;
    emptyNote: string;
    hiddenNote: string;
    openFull: string;
    addColumn: string;
    columnAdded: string;
    columnLocked: string;
    filterEqual: string;
    droppedPaths: string;
    cutValues: string;
    valueCut: string;
  };
  detail: {
    title: string;
    openLog: string;
    close: string;
    transactionId: string;
    requestId: string;
    user: string;
    time: string;
  };
  status: {
    rowsLoaded: string;
    rowsLoadedOne: string;
    filtering: string;
    hint: string;
    skipped: string;
    invalidCount: string;
    textCount: string;
    emptyCount: string;
    hiddenCount: string;
  };
  empty: {
    noSource: string;
    noSourceHint: string;
    notInstalled: string;
    collision: string;
    unavailable: string;
    issues: string;
    issueError: string;
    issueWarning: string;
  };
  viewer: {
    title: string;
    loading: string;
    refresh: string;
    loadMore: string;
    entriesCount: string;
    entriesCountOne: string;
    errorsCount: string;
    errorsCountOne: string;
    warningsCount: string;
    warningsCountOne: string;
    openApexLog: string;
    apexLinked: string;
    apexNotFound: string;
    apexUnavailable: string;
    apexNoRequestId: string;
    headerPayload: string;
    search: string;
    levelFilter: string;
    detailFilter: string;
    showSystem: string;
    columns: {
      sequence: string;
      time: string;
      level: string;
      origin: string;
      message: string;
    };
    status: {
      entriesLoaded: string;
      entriesLoadedOne: string;
      entriesShown: string;
    };
    noEntries: string;
    noMatch: string;
    noMatchMore: string;
    entry: {
      title: string;
      close: string;
      copy: string;
      copyMessage: string;
      fields: string;
      loadingFields: string;
      open: string;
      stateEmpty: string;
      stateHidden: string;
      truncatedByLogger: string;
      clipped: string;
      sequence: string;
      time: string;
      origin: string;
      user: string;
      exception: string;
      record: string;
      field: string;
    };
    errors: {
      log: string;
      entries: string;
      entry: string;
      field: string;
      apexLog: string;
    };
  };
};

export const customLogsEn: CustomLogsMessages = {
  title: 'Custom Logs',
  source: 'Source',
  refresh: 'Refresh',
  openInEditor: 'Open in editor',
  openInEditorTitle: 'Open Custom Logs in an editor tab',
  configure: 'Configure',
  configureTitle: 'Open the Custom Logs mapping in sfdx-project.json',
  loadMore: 'Load more',
  loading: 'Loading logs…',
  noRows: 'No logs found for this source and these filters.',
  noMatch: 'No loaded row matches. Only {count} rows are loaded.',
  noMatchMore: 'Use Load more to widen the search.',
  filter: {
    placeholder: 'Filter: field → operator → value   ( / to focus )',
    aria: 'Filter logs',
    serverChip: 'Runs in Salesforce: changes the query and reloads the list',
    loadedChip: 'Narrows the rows already loaded',
    sourceChip: 'The source this list reads from, set in Salesforce',
    removeChip: 'Remove filter {filter}',
    editChip: 'Edit filter {filter}',
    stageField: 'Field · Enter to filter on it · Shift+Enter to add it as a column',
    stageOperator: 'Operator for {field}',
    stageValue: 'Value · pick one or type it, then Enter · {field} {op} …',
    stageCommit: 'Enter to add the filter',
    noSuggestions: 'No suggestion: type a value and press Enter',
    serverBadge: 'Salesforce',
    inColumns: '✓ column',
    rowsCount: '{count} rows',
    rowCountOne: '1 row'
  },
  errors: {
    at: '(col {position})',
    expectedField: 'Expected a field name, for example http.status',
    expectedOperator: 'Expected an operator after "{token}": = != > >= < <= contains exists',
    expectedValue: 'Expected a value after the operator',
    unterminatedString: 'This string is not closed',
    unsupportedOr: '"or" is not supported yet: conditions combine with "and" only',
    expectedAnd: 'Unexpected "{token}": join conditions with "and", and quote values that contain spaces',
    expectedConditionAfterAnd: 'Expected another condition after "and"',
    serverOperator: '{field} only supports {allowed}',
    serverLevel: 'Use one of FINEST, FINER, FINE, DEBUG, INFO, WARN or ERROR',
    serverSince: 'Use a duration such as 30m, 24h or 7d, or an ISO date with an offset such as 2026-10-29T12:00:00Z',
    serverSource: 'Unknown source. Pick one from the Source list',
    serverUnsupported: 'This source cannot filter by {field}'
  },
  columns: {
    time: 'Time',
    level: 'Level',
    title: 'Title',
    user: 'User',
    counts: 'Entries',
    entries: 'entries',
    errors: 'errors',
    warnings: 'warnings'
  },
  table: {
    aria: 'Custom logs',
    addField: '+ Field',
    addFieldTitle: 'Add a JSON field as a column',
    columnMenu: 'Column menu for {column}',
    sortedAscending: 'sorted ascending',
    sortedDescending: 'sorted descending',
    fromProject: 'Column from the project mapping',
    payloadColumn: 'JSON field {path} · {type} · in {rows} of {total} loaded rows'
  },
  menu: {
    sortAscending: 'Sort ascending',
    sortDescending: 'Sort descending',
    filterBy: 'Filter by this field…',
    remove: 'Remove column',
    hide: 'Hide column'
  },
  picker: {
    title: 'From payload · {shown} of {total}',
    search: 'Search {count} discovered fields…',
    empty: 'No discovered field matches.',
    typeString: 'str',
    typeNumber: 'num',
    typeBoolean: 'bool',
    typeMixed: 'mixed',
    typeNull: 'null'
  },
  payload: {
    title: 'Payload',
    invalid: 'invalid JSON',
    text: 'plain text',
    empty: 'empty',
    hidden: 'hidden',
    invalidNote:
      'The payload is not valid JSON. JSON columns and filters skip this row. Open the full payload to read it.',
    textNote:
      'The payload is plain text, not JSON. JSON columns and filters skip this row. Open the full payload to read it.',
    emptyNote: 'The payload is empty for this record.',
    hiddenNote: 'Your permissions hide the payload field for this record.',
    openFull: 'Open full payload',
    addColumn: '+ Column',
    columnAdded: '✓ Column',
    columnLocked: 'From project',
    filterEqual: '= value',
    droppedPaths: '{count} more paths are not shown. Open the full payload to read them.',
    cutValues: 'Cut at the character limit: {paths}',
    valueCut: 'cut'
  },
  detail: {
    title: 'Log detail',
    openLog: 'Open log',
    close: 'Close detail',
    transactionId: 'Transaction',
    requestId: 'Request',
    user: 'User',
    time: 'Time'
  },
  status: {
    rowsLoaded: '{count} rows loaded',
    rowsLoadedOne: '1 row loaded',
    filtering: 'Filtering {loaded} loaded rows · {matches} match',
    hint: 'JSON columns, filters and sorts only see rows already loaded (SOQL cannot filter long text).',
    skipped: 'skipped by JSON filters',
    invalidCount: '{count} invalid JSON',
    textCount: '{count} plain text',
    emptyCount: '{count} empty',
    hiddenCount: '{count} hidden'
  },
  empty: {
    noSource: 'No custom log source is ready in this org.',
    noSourceHint: 'Install Nebula Logger, or map your own log object in sfdx-project.json.',
    notInstalled: '{label} is not installed in this org.',
    collision: '{label}: this org has a Log__c that is not Nebula Logger. Map it in sfdx-project.json.',
    unavailable: '{label} is unavailable: {message}',
    issues: 'Configuration issues',
    issueError: 'Error',
    issueWarning: 'Warning'
  },
  viewer: {
    title: 'Custom log',
    loading: 'Loading entries…',
    refresh: 'Refresh',
    loadMore: 'Load more entries',
    entriesCount: '{count} entries',
    entriesCountOne: '1 entry',
    errorsCount: '{count} errors',
    errorsCountOne: '1 error',
    warningsCount: '{count} warnings',
    warningsCountOne: '1 warning',
    openApexLog: 'Open Apex log',
    apexLinked: 'Open the Apex debug log of the same request',
    apexNotFound: 'No Apex debug log for this request: no trace flag was active, or Salesforce already deleted it.',
    apexUnavailable: 'You cannot read debug logs in this org.',
    apexNoRequestId: 'This log has no request id, so it cannot be linked to an Apex debug log.',
    headerPayload: 'Header payload',
    search: 'Search entries…',
    levelFilter: 'Filter by level',
    detailFilter: 'Filter by long field',
    showSystem: 'Show logger system messages',
    columns: {
      sequence: '#',
      time: 'Time',
      level: 'Level',
      origin: 'Origin',
      message: 'Message'
    },
    status: {
      entriesLoaded: '{count} entries loaded',
      entriesLoadedOne: '1 entry loaded',
      entriesShown: '{shown} of {loaded} entries shown'
    },
    noEntries: 'This log has no entries.',
    noMatch: 'No loaded entry matches the current filters.',
    noMatchMore: 'Use Load more entries to widen the search.',
    entry: {
      title: 'Entry detail',
      close: 'Close entry',
      copy: 'Copy',
      copyMessage: 'Copy message',
      fields: 'Long fields',
      loadingFields: 'Loading fields…',
      open: 'Open',
      stateEmpty: 'empty',
      stateHidden: 'hidden by your permissions',
      truncatedByLogger: 'truncated by the logger',
      clipped: 'preview cut: open the message to read it in full',
      sequence: 'Sequence',
      time: 'Time',
      origin: 'Origin',
      user: 'User',
      exception: 'Exception',
      record: 'Record',
      field: 'Field'
    },
    errors: {
      log: 'Could not load the log',
      entries: 'Could not load the entries',
      entry: 'Could not load the entry',
      field: 'Could not open the field',
      apexLog: 'Could not open the Apex log'
    }
  }
};

export const customLogsPtBR: CustomLogsMessages = {
  title: 'Logs personalizados',
  source: 'Fonte',
  refresh: 'Atualizar',
  openInEditor: 'Abrir no editor',
  openInEditorTitle: 'Abrir Logs personalizados em uma aba do editor',
  configure: 'Configurar',
  configureTitle: 'Abrir o mapeamento de Logs personalizados no sfdx-project.json',
  loadMore: 'Carregar mais',
  loading: 'Carregando logs…',
  noRows: 'Nenhum log encontrado para esta fonte e estes filtros.',
  noMatch: 'Nenhuma linha carregada corresponde. Só {count} linhas estão carregadas.',
  noMatchMore: 'Use Carregar mais para ampliar a busca.',
  filter: {
    placeholder: 'Filtrar: campo → operador → valor   ( / para focar )',
    aria: 'Filtrar logs',
    serverChip: 'Roda no Salesforce: muda a consulta e recarrega a lista',
    loadedChip: 'Restringe só as linhas já carregadas',
    sourceChip: 'A fonte que esta lista lê, definida no Salesforce',
    removeChip: 'Remover o filtro {filter}',
    editChip: 'Editar o filtro {filter}',
    stageField: 'Campo · Enter para filtrar por ele · Shift+Enter para adicioná-lo como coluna',
    stageOperator: 'Operador para {field}',
    stageValue: 'Valor · escolha um ou digite, depois Enter · {field} {op} …',
    stageCommit: 'Enter para adicionar o filtro',
    noSuggestions: 'Sem sugestões: digite um valor e pressione Enter',
    serverBadge: 'Salesforce',
    inColumns: '✓ coluna',
    rowsCount: '{count} linhas',
    rowCountOne: '1 linha'
  },
  errors: {
    at: '(col. {position})',
    expectedField: 'Esperava o nome de um campo, por exemplo http.status',
    expectedOperator: 'Esperava um operador depois de "{token}": = != > >= < <= contains exists',
    expectedValue: 'Esperava um valor depois do operador',
    unterminatedString: 'Este texto entre aspas não foi fechado',
    unsupportedOr: '"or" ainda não é suportado: as condições se combinam só com "and"',
    expectedAnd:
      'Trecho inesperado "{token}": junte as condições com "and" e coloque entre aspas os valores com espaços',
    expectedConditionAfterAnd: 'Esperava outra condição depois de "and"',
    serverOperator: '{field} só aceita {allowed}',
    serverLevel: 'Use FINEST, FINER, FINE, DEBUG, INFO, WARN ou ERROR',
    serverSince: 'Use uma duração como 30m, 24h ou 7d, ou uma data ISO com offset, como 2026-10-29T12:00:00Z',
    serverSource: 'Fonte desconhecida. Escolha uma na lista Fonte',
    serverUnsupported: 'Esta fonte não filtra por {field}'
  },
  columns: {
    time: 'Hora',
    level: 'Nível',
    title: 'Título',
    user: 'Usuário',
    counts: 'Entradas',
    entries: 'entradas',
    errors: 'erros',
    warnings: 'avisos'
  },
  table: {
    aria: 'Logs personalizados',
    addField: '+ Campo',
    addFieldTitle: 'Adicionar um campo JSON como coluna',
    columnMenu: 'Menu da coluna {column}',
    sortedAscending: 'em ordem crescente',
    sortedDescending: 'em ordem decrescente',
    fromProject: 'Coluna do mapeamento do projeto',
    payloadColumn: 'Campo JSON {path} · {type} · em {rows} de {total} linhas carregadas'
  },
  menu: {
    sortAscending: 'Ordem crescente',
    sortDescending: 'Ordem decrescente',
    filterBy: 'Filtrar por este campo…',
    remove: 'Remover coluna',
    hide: 'Ocultar coluna'
  },
  picker: {
    title: 'Do payload · {shown} de {total}',
    search: 'Buscar entre {count} campos descobertos…',
    empty: 'Nenhum campo descoberto corresponde.',
    typeString: 'txt',
    typeNumber: 'num',
    typeBoolean: 'bool',
    typeMixed: 'misto',
    typeNull: 'nulo'
  },
  payload: {
    title: 'Payload',
    invalid: 'JSON inválido',
    text: 'texto simples',
    empty: 'vazio',
    hidden: 'oculto',
    invalidNote:
      'O payload não é um JSON válido. As colunas e os filtros JSON ignoram esta linha. Abra o payload completo para lê-lo.',
    textNote:
      'O payload é texto simples, não JSON. As colunas e os filtros JSON ignoram esta linha. Abra o payload completo para lê-lo.',
    emptyNote: 'O payload está vazio neste registro.',
    hiddenNote: 'Suas permissões ocultam o campo de payload neste registro.',
    openFull: 'Abrir payload completo',
    addColumn: '+ Coluna',
    columnAdded: '✓ Coluna',
    columnLocked: 'Do projeto',
    filterEqual: '= valor',
    droppedPaths: 'Mais {count} caminhos não são exibidos. Abra o payload completo para lê-los.',
    cutValues: 'Cortados no limite de caracteres: {paths}',
    valueCut: 'cortado'
  },
  detail: {
    title: 'Detalhe do log',
    openLog: 'Abrir log',
    close: 'Fechar detalhe',
    transactionId: 'Transação',
    requestId: 'Requisição',
    user: 'Usuário',
    time: 'Hora'
  },
  status: {
    rowsLoaded: '{count} linhas carregadas',
    rowsLoadedOne: '1 linha carregada',
    filtering: 'Filtrando {loaded} linhas carregadas · {matches} correspondem',
    hint: 'Colunas, filtros e ordenações JSON só enxergam as linhas já carregadas (o SOQL não filtra texto longo).',
    skipped: 'ignoradas pelos filtros JSON',
    invalidCount: '{count} JSON inválido',
    textCount: '{count} texto simples',
    emptyCount: '{count} vazio',
    hiddenCount: '{count} oculto'
  },
  empty: {
    noSource: 'Nenhuma fonte de logs personalizados está pronta nesta org.',
    noSourceHint: 'Instale o Nebula Logger ou mapeie seu próprio objeto de log no sfdx-project.json.',
    notInstalled: '{label} não está instalado nesta org.',
    collision: '{label}: esta org tem um Log__c que não é o Nebula Logger. Mapeie-o no sfdx-project.json.',
    unavailable: '{label} está indisponível: {message}',
    issues: 'Problemas de configuração',
    issueError: 'Erro',
    issueWarning: 'Aviso'
  },
  viewer: {
    title: 'Log personalizado',
    loading: 'Carregando entradas…',
    refresh: 'Atualizar',
    loadMore: 'Carregar mais entradas',
    entriesCount: '{count} entradas',
    entriesCountOne: '1 entrada',
    errorsCount: '{count} erros',
    errorsCountOne: '1 erro',
    warningsCount: '{count} avisos',
    warningsCountOne: '1 aviso',
    openApexLog: 'Abrir log do Apex',
    apexLinked: 'Abrir o log de debug do Apex da mesma requisição',
    apexNotFound:
      'Não há log de debug do Apex para esta requisição: nenhuma trace flag estava ativa ou o Salesforce já o excluiu.',
    apexUnavailable: 'Você não tem permissão para ler logs de debug nesta org.',
    apexNoRequestId: 'Este log não tem id de requisição, então não dá para ligá-lo a um log de debug do Apex.',
    headerPayload: 'Payload do cabeçalho',
    search: 'Buscar entradas…',
    levelFilter: 'Filtrar por nível',
    detailFilter: 'Filtrar por campo longo',
    showSystem: 'Mostrar mensagens de sistema do logger',
    columns: {
      sequence: '#',
      time: 'Hora',
      level: 'Nível',
      origin: 'Origem',
      message: 'Mensagem'
    },
    status: {
      entriesLoaded: '{count} entradas carregadas',
      entriesLoadedOne: '1 entrada carregada',
      entriesShown: '{shown} de {loaded} entradas exibidas'
    },
    noEntries: 'Este log não tem entradas.',
    noMatch: 'Nenhuma entrada carregada corresponde aos filtros atuais.',
    noMatchMore: 'Use Carregar mais entradas para ampliar a busca.',
    entry: {
      title: 'Detalhe da entrada',
      close: 'Fechar entrada',
      copy: 'Copiar',
      copyMessage: 'Copiar mensagem',
      fields: 'Campos longos',
      loadingFields: 'Carregando campos…',
      open: 'Abrir',
      stateEmpty: 'vazio',
      stateHidden: 'oculto pelas suas permissões',
      truncatedByLogger: 'truncado pelo logger',
      clipped: 'prévia cortada: abra a mensagem para lê-la inteira',
      sequence: 'Sequência',
      time: 'Hora',
      origin: 'Origem',
      user: 'Usuário',
      exception: 'Exceção',
      record: 'Registro',
      field: 'Campo'
    },
    errors: {
      log: 'Não foi possível carregar o log',
      entries: 'Não foi possível carregar as entradas',
      entry: 'Não foi possível carregar a entrada',
      field: 'Não foi possível abrir o campo',
      apexLog: 'Não foi possível abrir o log do Apex'
    }
  }
};
