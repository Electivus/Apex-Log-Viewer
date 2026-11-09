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
  onlySystem: string;
  search: {
    label: string;
    placeholder: string;
    clear: string;
  };
  filters: {
    button: string;
    level: string;
    levelAny: string;
    levelAtLeast: string;
    user: string;
    userAny: string;
    time: string;
    timeAny: string;
    timeQuick: Record<'1h' | '24h' | '7d', string>;
    note: string;
    noteStored: string;
    clear: string;
    showSystem: string;
  };
  columns: {
    time: string;
    level: string;
    title: string;
    origin: string;
    user: string;
    log: string;
    logField: string;
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
    origin: string;
    log: string;
    logStart: string;
    logLevel: string;
    logEntries: string;
  };
  status: {
    rowsLoaded: string;
    rowsLoadedOne: string;
    searching: string;
    searchMore: string;
    systemHidden: string;
    systemHiddenOne: string;
    hint: string;
    hintStored: string;
    invalidCount: string;
    textCount: string;
    emptyCount: string;
    hiddenCount: string;
  };
  capture: {
    aria: string;
    stop: string;
    start: string;
    connecting: string;
    catchingUpPosition: string;
    catchingUpRetained: string;
    catchingUpNew: string;
    live: string;
    liveHint: string;
    storedSince: string;
    nothingStored: string;
    reconnecting: string;
    reconnectCause: { transport: string; auth: string; overflow: string };
    stopped: string;
    budget: string;
    budgetNoAllowance: string;
    standby: string;
    leaseNote: string;
    surface: { vscode: string; cli: string };
    firstUse: {
      empty: string;
      loadRetained: string;
      onlyNew: string;
      note: string;
      noteNoBudget: string;
      left: string;
      leftOnly: string;
    };
    failed: string;
    deliveryLimit: string;
    gaps: {
      aria: string;
      between: string;
      after: string;
      before: string;
      unknown: string;
      reasons: { cursorRejected: string; retentionElapsed: string; orgChanged: string; malformedEvent: string };
    };
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
    apexOffline: string;
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
    focus: {
      notLoaded: string;
      notFound: string;
      dismiss: string;
    };
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
  onlySystem: 'Only logger system messages are loaded. Turn on Show logger system messages in Filters to list them.',
  search: {
    label: 'Search loaded rows',
    placeholder: 'Search loaded rows   ( / to focus )',
    clear: 'Clear search'
  },
  filters: {
    button: 'Filters',
    level: 'Level',
    levelAny: 'Any level',
    levelAtLeast: '{level} and above',
    user: 'Logged by',
    userAny: 'Anyone',
    time: 'Time',
    timeAny: 'Any time',
    timeQuick: { '1h': 'Last hour', '24h': 'Last 24 hours', '7d': 'Last 7 days' },
    note: 'Runs in Salesforce: changes the query and reloads the list.',
    noteStored: 'Runs over the stored events: changes the list without asking Salesforce.',
    clear: 'Clear filters',
    showSystem: 'Show logger system messages'
  },
  columns: {
    time: 'Time',
    level: 'Level',
    title: 'Message',
    origin: 'Origin',
    user: 'User',
    log: 'Log',
    logField: 'Log: {label}'
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
      'The payload is not valid JSON. JSON columns and the search skip it. Open the full payload to read it.',
    textNote:
      'The payload is plain text, not JSON. JSON columns and the search skip it. Open the full payload to read it.',
    emptyNote: 'The payload is empty for this record.',
    hiddenNote: 'Your permissions hide the payload field for this record.',
    openFull: 'Open full payload',
    addColumn: '+ Column',
    columnAdded: '✓ Column',
    columnLocked: 'From project',
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
    time: 'Time',
    origin: 'Origin',
    log: 'Log',
    logStart: 'Started',
    logLevel: 'Worst level',
    logEntries: 'Entries'
  },
  status: {
    rowsLoaded: '{count} rows loaded',
    rowsLoadedOne: '1 row loaded',
    searching: '{matches} of {loaded} loaded rows match',
    searchMore: 'Load more to search older rows',
    systemHidden: '{count} logger system messages hidden',
    systemHiddenOne: '1 logger system message hidden',
    hint: 'Search, JSON columns and sorts only see rows already loaded (SOQL cannot search long text).',
    hintStored: 'Search, JSON columns and sorts only see rows already loaded.',
    invalidCount: '{count} invalid JSON',
    textCount: '{count} plain text',
    emptyCount: '{count} empty',
    hiddenCount: '{count} hidden'
  },
  capture: {
    aria: 'Event capture',
    stop: 'Stop',
    start: 'Start',
    connecting: 'Connecting to {source}…',
    catchingUpPosition: 'Catching up: loading events Salesforce kept since {since}',
    catchingUpRetained: 'Loading retained events (at least 72 hours)…',
    catchingUpNew: 'Waiting for new events…',
    live: 'Live',
    liveHint: 'Inferred: no event for 10 s. Salesforce sends no end-of-backlog marker.',
    storedSince: 'stored since {since}',
    nothingStored: 'no events stored yet',
    reconnecting: 'Reconnecting (attempt {attempt}) {cause}…',
    reconnectCause: {
      transport: 'after the connection dropped',
      auth: 'after Salesforce rejected the session',
      overflow: 'after a burst of events'
    },
    stopped: 'Stopped',
    budget:
      "Paused: this run spent its delivery budget (about {budget} deliveries of the org's daily allocation). Start to resume from the stored position.",
    budgetNoAllowance: 'Paused: this run spent its delivery budget. Start to resume from the stored position.',
    standby: 'Another {surface} (pid {pid} on {host}) is capturing; new events appear here.',
    leaseNote: 'If no such process exists (the host name may have changed), delete capture.lease in {folder}.',
    surface: { vscode: 'VS Code window', cli: 'sf command' },
    firstUse: {
      empty: 'No events from this org are stored yet.',
      loadRetained: 'Load retained events',
      onlyNew: 'Only new events',
      note: "Salesforce keeps at least 72 hours; each event counts against the org's daily delivery allocation{left}; this run stops after about {budget} deliveries and resumes on the next Start.",
      noteNoBudget:
        "Salesforce keeps at least 72 hours; each event counts against the org's daily delivery allocation.",
      left: ' (about {remaining} of {max} left)',
      leftOnly: ' (about {remaining} left)'
    },
    failed: 'Capture failed: {message}',
    deliveryLimit:
      "Salesforce's daily event delivery limit is used up; capture resumes from the stored position later.",
    gaps: {
      aria: 'Possible gaps in the stored events',
      between: 'Events between {after} and {before} may be missing ({reason})',
      after: 'Events after {after} may be missing ({reason})',
      before: 'Events before {before} may be missing ({reason})',
      unknown: 'Some events may be missing ({reason})',
      reasons: {
        cursorRejected: 'Salesforce rejected the stored position when capture resumed',
        retentionElapsed: 'the stored position was older than Salesforce keeps events',
        orgChanged: 'this username now points to another org',
        malformedEvent: 'Salesforce delivered an event that capture could not read'
      }
    }
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
    apexOffline: 'Could not reach the org to look up the Apex debug log for this request.',
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
    focus: {
      notLoaded: 'The entry you opened comes after the {count} loaded entries. Use Load more entries to reach it.',
      notFound: 'The entry you opened is no longer in this log.',
      dismiss: 'Dismiss'
    },
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
  onlySystem:
    'Só há mensagens de sistema do logger carregadas. Ative Mostrar mensagens de sistema do logger em Filtros para listá-las.',
  search: {
    label: 'Buscar nas linhas carregadas',
    placeholder: 'Buscar nas linhas carregadas   ( / para focar )',
    clear: 'Limpar a busca'
  },
  filters: {
    button: 'Filtros',
    level: 'Nível',
    levelAny: 'Qualquer nível',
    levelAtLeast: '{level} ou mais grave',
    user: 'Registrado por',
    userAny: 'Qualquer pessoa',
    time: 'Período',
    timeAny: 'Qualquer período',
    timeQuick: { '1h': 'Última hora', '24h': 'Últimas 24 horas', '7d': 'Últimos 7 dias' },
    note: 'Roda no Salesforce: muda a consulta e recarrega a lista.',
    noteStored: 'Roda sobre os eventos armazenados: muda a lista sem consultar o Salesforce.',
    clear: 'Limpar filtros',
    showSystem: 'Mostrar mensagens de sistema do logger'
  },
  columns: {
    time: 'Hora',
    level: 'Nível',
    title: 'Mensagem',
    origin: 'Origem',
    user: 'Usuário',
    log: 'Log',
    logField: 'Log: {label}'
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
      'O payload não é um JSON válido. As colunas JSON e a busca o ignoram. Abra o payload completo para lê-lo.',
    textNote:
      'O payload é texto simples, não JSON. As colunas JSON e a busca o ignoram. Abra o payload completo para lê-lo.',
    emptyNote: 'O payload está vazio neste registro.',
    hiddenNote: 'Suas permissões ocultam o campo de payload neste registro.',
    openFull: 'Abrir payload completo',
    addColumn: '+ Coluna',
    columnAdded: '✓ Coluna',
    columnLocked: 'Do projeto',
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
    time: 'Hora',
    origin: 'Origem',
    log: 'Log',
    logStart: 'Início',
    logLevel: 'Nível mais grave',
    logEntries: 'Entradas'
  },
  status: {
    rowsLoaded: '{count} linhas carregadas',
    rowsLoadedOne: '1 linha carregada',
    searching: '{matches} de {loaded} linhas carregadas correspondem',
    searchMore: 'Carregue mais para buscar linhas mais antigas',
    systemHidden: '{count} mensagens de sistema do logger ocultas',
    systemHiddenOne: '1 mensagem de sistema do logger oculta',
    hint: 'A busca, as colunas JSON e as ordenações só enxergam as linhas já carregadas (o SOQL não busca texto longo).',
    hintStored: 'A busca, as colunas JSON e as ordenações só enxergam as linhas já carregadas.',
    invalidCount: '{count} JSON inválido',
    textCount: '{count} texto simples',
    emptyCount: '{count} vazio',
    hiddenCount: '{count} oculto'
  },
  capture: {
    aria: 'Captura de eventos',
    stop: 'Parar',
    start: 'Iniciar',
    connecting: 'Conectando a {source}…',
    catchingUpPosition: 'Recuperando: carregando os eventos que o Salesforce guardou desde {since}',
    catchingUpRetained: 'Carregando os eventos retidos (pelo menos 72 horas)…',
    catchingUpNew: 'Aguardando novos eventos…',
    live: 'Ao vivo',
    liveHint: 'Inferido: nenhum evento por 10 s. O Salesforce não envia um marcador de fim do backlog.',
    storedSince: 'armazenados desde {since}',
    nothingStored: 'nenhum evento armazenado ainda',
    reconnecting: 'Reconectando (tentativa {attempt}) {cause}…',
    reconnectCause: {
      transport: 'após a conexão cair',
      auth: 'após o Salesforce rejeitar a sessão',
      overflow: 'após uma rajada de eventos'
    },
    stopped: 'Parada',
    budget:
      'Pausada: esta execução gastou o orçamento de entregas (cerca de {budget} entregas da cota diária da org). Inicie para continuar da posição armazenada.',
    budgetNoAllowance:
      'Pausada: esta execução gastou o orçamento de entregas. Inicie para continuar da posição armazenada.',
    standby: 'Outro processo ({surface}, pid {pid} em {host}) está capturando; os novos eventos aparecem aqui.',
    leaseNote: 'Se esse processo não existir (o nome do host pode ter mudado), apague capture.lease em {folder}.',
    surface: { vscode: 'janela do VS Code', cli: 'comando sf' },
    firstUse: {
      empty: 'Ainda não há eventos desta org armazenados.',
      loadRetained: 'Carregar eventos retidos',
      onlyNew: 'Só eventos novos',
      note: 'O Salesforce guarda pelo menos 72 horas; cada evento conta na cota diária de entregas da org{left}; esta execução para após cerca de {budget} entregas e continua no próximo Iniciar.',
      noteNoBudget: 'O Salesforce guarda pelo menos 72 horas; cada evento conta na cota diária de entregas da org.',
      left: ' (cerca de {remaining} de {max} restantes)',
      leftOnly: ' (cerca de {remaining} restantes)'
    },
    failed: 'A captura falhou: {message}',
    deliveryLimit:
      'O limite diário de entrega de eventos do Salesforce foi usado; a captura continua da posição armazenada mais tarde.',
    gaps: {
      aria: 'Possíveis lacunas nos eventos armazenados',
      between: 'Podem faltar eventos entre {after} e {before} ({reason})',
      after: 'Podem faltar eventos depois de {after} ({reason})',
      before: 'Podem faltar eventos antes de {before} ({reason})',
      unknown: 'Podem faltar alguns eventos ({reason})',
      reasons: {
        cursorRejected: 'o Salesforce rejeitou a posição armazenada quando a captura continuou',
        retentionElapsed: 'a posição armazenada era mais antiga do que o Salesforce guarda eventos',
        orgChanged: 'este usuário agora aponta para outra org',
        malformedEvent: 'o Salesforce entregou um evento que a captura não conseguiu ler'
      }
    }
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
    apexOffline: 'Não foi possível acessar a org para buscar o log de debug do Apex desta requisição.',
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
    focus: {
      notLoaded:
        'A entrada que você abriu vem depois das {count} entradas carregadas. Use Carregar mais entradas para chegar até ela.',
      notFound: 'A entrada que você abriu não está mais neste log.',
      dismiss: 'Dispensar'
    },
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
