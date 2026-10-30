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
};

export type Messages = {
  refresh: string;
  loading: string;
  warningLabel?: string;
  searchPreparing?: string;
  searchPending?: string;
  searchPendingPlural?: string;
  noLogs: string;
  replay: string;
  loadMore?: string;
  loadMoreFiltered?: string;
  downloadAllLogs?: string;
  logsCleanup?: {
    open: string;
    openTitle: string;
    deleteAll: string;
    deleteMine: string;
    hintStorageFull: string;
  };
  open?: string;
  orgLabel: string;
  defaultOrg: string;
  searchPlaceholder?: string;
  noOrgsDetected?: string;
  tail?: {
    start: string;
    stop: string;
    clear: string;
    openLog: string;
    openSelectedLogTitle: string;
    replayDebugger: string;
    replayDebuggerTitle: string;
    searchLivePlaceholder: string;
    debugOnly: string;
    colorize: string;
    debugLevel: string;
    select: string;
    autoScroll: string;
    waiting: string;
    pressStart: string;
    selectDebugLevel: string;
    debugTag?: string;
  };
  filters?: {
    user: string;
    operation: string;
    status: string;
    errorsOnly: string;
    errorDetectedBadge: string;
    scanningErrors: string;
    scanningErrorsProgress: string;
    all: string;
    clear: string;
  };
  columns: {
    user: string;
    application: string;
    operation: string;
    time: string;
    duration: string;
    status: string;
    size: string;
    match?: string;
  };
  columnsConfig?: {
    button: string;
    title: string;
    subtitle?: string;
    reset: string;
    matchRequiresFullSearch: string;
    moveUp: string;
    moveDown: string;
  };
  debugFlags?: {
    open: string;
    openTitle: string;
    panelTitle: string;
    panelSubtitle: string;
    org: string;
    specialTargets?: string;
    specialTargetAutomatedProcess?: string;
    specialTargetAutomatedProcessHint?: string;
    specialTargetPlatformIntegration?: string;
    specialTargetPlatformIntegrationHint?: string;
    userSearchLabel: string;
    userSearchPlaceholder: string;
    users: string;
    noUsers: string;
    loadingUsers: string;
    selectTargetHint?: string;
    debugLevel: string;
    ttlMinutes: string;
    apply: string;
    remove: string;
    currentStatus: string;
    selectedTarget?: string;
    statusActive: string;
    statusInactive: string;
    statusMatchedTargets?: string;
    statusActiveTargets?: string;
    statusLevel: string;
    statusExpiration: string;
    statusStart: string;
    statusMixed?: string;
    noStatus: string;
    targetUnavailable?: string;
    noticeCreated: string;
    noticeUpdated: string;
    noticeRemoved: string;
    noticeNone: string;
    ttlHelper: string;
    managerTitle?: string;
    managerSubtitle?: string;
    managerExisting?: string;
    managerNewPlaceholder?: string;
    managerNew?: string;
    managerPreset?: string;
    managerPresetPlaceholder?: string;
    managerApplyPreset?: string;
    managerDeveloperName?: string;
    managerMasterLabel?: string;
    managerLanguage?: string;
    managerSave?: string;
    managerReset?: string;
    managerDelete?: string;
    managerDeleteConfirmPrompt?: string;
    managerDeleteConfirmAction?: string;
    managerDeleteCancel?: string;
    managerValidation?: string;
  };
  customLogs: CustomLogsMessages;
};

const en: Messages = {
  refresh: 'Refresh',
  loading: 'Loading…',
  warningLabel: 'Warning',
  searchPreparing: 'Preparing search results…',
  searchPending: 'Waiting for {count} log to finish downloading…',
  searchPendingPlural: 'Waiting for {count} logs to finish downloading…',
  noLogs: 'No logs found.',
  replay: 'Apex Replay',
  loadMore: 'Load more logs',
  loadMoreFiltered: 'Load more results',
  downloadAllLogs: 'Download all logs',
  logsCleanup: {
    open: 'Clear logs',
    openTitle: 'Delete Apex logs from the selected org',
    deleteAll: 'Delete all org logs',
    deleteMine: 'Delete my logs',
    hintStorageFull: 'Org log storage appears full. Use Clear logs → Delete all org logs.'
  },
  open: 'Open',
  orgLabel: 'Org',
  defaultOrg: 'Default Org',
  searchPlaceholder: 'Search logs…',
  noOrgsDetected: 'No orgs detected. Run "sf org list".',
  tail: {
    start: 'Start',
    stop: 'Stop',
    clear: 'Clear',
    openLog: 'Open Log',
    openSelectedLogTitle: 'Open selected log',
    replayDebugger: 'Replay Debugger',
    replayDebuggerTitle: 'Apex Replay Debugger',
    searchLivePlaceholder: 'Search live logs…',
    debugOnly: 'Debug Only',
    colorize: 'Color',
    debugLevel: 'Debug level',
    select: 'Select',
    autoScroll: 'Auto-scroll',
    waiting: 'Waiting for logs…',
    pressStart: 'Press Start to tail logs.',
    selectDebugLevel: 'Select a debug level',
    debugTag: 'debug'
  },
  filters: {
    user: 'User',
    operation: 'Operation',
    status: 'Status',
    errorsOnly: 'Errors only',
    errorDetectedBadge: 'Error',
    scanningErrors: 'Scanning logs for errors…',
    scanningErrorsProgress: 'Scanning logs for errors… ({processed}/{total}, found: {errorsFound})',
    all: 'All',
    clear: 'Clear filters'
  },
  columns: {
    user: 'User',
    application: 'Application',
    operation: 'Operation',
    time: 'Time',
    duration: 'Duration',
    status: 'Status',
    size: 'Size',
    match: 'Match'
  },
  columnsConfig: {
    button: 'Columns',
    title: 'Columns',
    subtitle: 'Show/hide and reorder columns',
    reset: 'Reset to defaults',
    matchRequiresFullSearch: 'Requires full log search',
    moveUp: 'Move up',
    moveDown: 'Move down'
  },
  debugFlags: {
    open: 'Debug Flags',
    openTitle: 'Open debug flags editor',
    panelTitle: 'Apex Debug Flags',
    panelSubtitle: 'Configure USER_DEBUG trace flags for active users and special Salesforce targets.',
    org: 'Org',
    specialTargets: 'Special targets',
    specialTargetAutomatedProcess: 'Automated Process',
    specialTargetAutomatedProcessHint: 'Capture callbacks and system automation logs.',
    specialTargetPlatformIntegration: 'Platform Integration',
    specialTargetPlatformIntegrationHint: 'Capture asynchronous integration callback logs.',
    userSearchLabel: 'Find user',
    userSearchPlaceholder: 'Type name or username…',
    users: 'Active users',
    noUsers: 'No active users found for this query.',
    loadingUsers: 'Loading users…',
    selectTargetHint: 'Select a special target or an active user to inspect and configure debug flags.',
    debugLevel: 'Debug level',
    ttlMinutes: 'TTL (minutes)',
    apply: 'Apply debug flag',
    remove: 'Remove debug flag',
    currentStatus: 'Current status',
    selectedTarget: 'Selected target',
    statusActive: 'Active',
    statusInactive: 'Inactive',
    statusMatchedTargets: 'Matched targets',
    statusActiveTargets: 'Active flags',
    statusLevel: 'Debug level',
    statusExpiration: 'Expires',
    statusStart: 'Starts',
    statusMixed: 'Mixed',
    noStatus: 'No active USER_DEBUG trace flag for this target.',
    targetUnavailable: 'This trace flag target is not available in this org.',
    noticeCreated: 'Debug flag created successfully.',
    noticeUpdated: 'Debug flag updated successfully.',
    noticeRemoved: 'Debug flag removed successfully.',
    noticeNone: 'No USER_DEBUG trace flag found for this target.',
    ttlHelper: 'Default is 30 minutes. Allowed range: 1-1440.',
    managerTitle: 'Debug Level Manager',
    managerSubtitle: 'Create from scratch, apply a preset, or edit an existing DebugLevel field by field.',
    managerExisting: 'Existing DebugLevel',
    managerNewPlaceholder: 'New draft',
    managerNew: 'New',
    managerPreset: 'Preset',
    managerPresetPlaceholder: 'Select a preset',
    managerApplyPreset: 'Apply preset',
    managerDeveloperName: 'DeveloperName',
    managerMasterLabel: 'MasterLabel',
    managerLanguage: 'Language',
    managerSave: 'Save',
    managerReset: 'Reset changes',
    managerDelete: 'Delete',
    managerDeleteConfirmPrompt: 'Delete this DebugLevel from the org?',
    managerDeleteConfirmAction: 'Delete',
    managerDeleteCancel: 'Cancel',
    managerValidation: 'DeveloperName and MasterLabel are required to save a DebugLevel.'
  },
  customLogs: {
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
      serverSince: 'Use a duration such as 30m, 24h or 7d, or an ISO date',
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
      invalidNote: 'The payload is not valid JSON. JSON columns and filters skip this row. Open the full payload to read it.',
      textNote: 'The payload is plain text, not JSON. JSON columns and filters skip this row. Open the full payload to read it.',
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
    }
  }
};

const ptBR: Messages = {
  refresh: 'Atualizar',
  loading: 'Carregando…',
  warningLabel: 'Aviso',
  searchPreparing: 'Preparando resultados da busca…',
  searchPending: 'Aguardando o download de {count} log…',
  searchPendingPlural: 'Aguardando o download de {count} logs…',
  noLogs: 'Nenhum log encontrado.',
  replay: 'Apex Replay',
  loadMore: 'Carregar mais logs',
  loadMoreFiltered: 'Carregar mais resultados',
  downloadAllLogs: 'Baixar todos os logs',
  logsCleanup: {
    open: 'Limpar logs',
    openTitle: 'Deletar logs Apex da org selecionada',
    deleteAll: 'Deletar todos os logs da org',
    deleteMine: 'Deletar meus logs',
    hintStorageFull: 'O armazenamento de logs da org parece cheio. Use Limpar logs → Deletar todos os logs da org.'
  },
  open: 'Abrir',
  orgLabel: 'Org',
  defaultOrg: 'Org Padrão',
  searchPlaceholder: 'Buscar logs…',
  noOrgsDetected: 'Nenhuma org detectada. Execute "sf org list".',
  tail: {
    start: 'Iniciar',
    stop: 'Parar',
    clear: 'Limpar',
    openLog: 'Abrir Log',
    openSelectedLogTitle: 'Abrir log selecionado',
    replayDebugger: 'Replay Debugger',
    replayDebuggerTitle: 'Apex Replay Debugger',
    searchLivePlaceholder: 'Buscar logs em tempo real…',
    debugOnly: 'Somente USER_DEBUG',
    colorize: 'Colorir saída',
    debugLevel: 'Nível de depuração',
    select: 'Selecionar',
    autoScroll: 'Rolagem automática',
    waiting: 'Aguardando logs…',
    pressStart: 'Pressione Iniciar para acompanhar os logs.',
    selectDebugLevel: 'Selecione um nível de depuração',
    debugTag: 'debug'
  },
  filters: {
    user: 'Usuário',
    operation: 'Operação',
    status: 'Status',
    errorsOnly: 'Somente erros',
    errorDetectedBadge: 'Erro',
    scanningErrors: 'Analisando logs em busca de erros…',
    scanningErrorsProgress: 'Analisando logs em busca de erros… ({processed}/{total}, encontrados: {errorsFound})',
    all: 'Todos',
    clear: 'Limpar filtros'
  },
  columns: {
    user: 'Usuário',
    application: 'Aplicação',
    operation: 'Operação',
    time: 'Tempo',
    duration: 'Duração',
    status: 'Status',
    size: 'Tamanho',
    match: 'Trecho'
  },
  columnsConfig: {
    button: 'Colunas',
    title: 'Colunas',
    subtitle: 'Mostrar/ocultar e reordenar colunas',
    reset: 'Restaurar padrão',
    matchRequiresFullSearch: 'Requer busca completa',
    moveUp: 'Mover para cima',
    moveDown: 'Mover para baixo'
  },
  debugFlags: {
    open: 'Debug Flags',
    openTitle: 'Abrir editor de debug flags',
    panelTitle: 'Apex Debug Flags',
    panelSubtitle: 'Configure trace flags USER_DEBUG para usuários ativos e alvos especiais do Salesforce.',
    org: 'Org',
    specialTargets: 'Alvos especiais',
    specialTargetAutomatedProcess: 'Automated Process',
    specialTargetAutomatedProcessHint: 'Capture logs de callbacks e automações do sistema.',
    specialTargetPlatformIntegration: 'Platform Integration',
    specialTargetPlatformIntegrationHint: 'Capture logs de callbacks assíncronos de integração.',
    userSearchLabel: 'Buscar usuário',
    userSearchPlaceholder: 'Digite nome ou username…',
    users: 'Usuários ativos',
    noUsers: 'Nenhum usuário ativo encontrado para esta busca.',
    loadingUsers: 'Carregando usuários…',
    selectTargetHint: 'Selecione um alvo especial ou um usuário ativo para inspecionar e configurar debug flags.',
    debugLevel: 'Nível de depuração',
    ttlMinutes: 'TTL (minutos)',
    apply: 'Aplicar debug flag',
    remove: 'Remover debug flag',
    currentStatus: 'Status atual',
    selectedTarget: 'Alvo selecionado',
    statusActive: 'Ativa',
    statusInactive: 'Inativa',
    statusMatchedTargets: 'Alvos correspondentes',
    statusActiveTargets: 'Flags ativas',
    statusLevel: 'Nível de depuração',
    statusExpiration: 'Expira em',
    statusStart: 'Inicia em',
    statusMixed: 'Misto',
    noStatus: 'Nenhuma trace flag USER_DEBUG ativa para este alvo.',
    targetUnavailable: 'Este alvo de trace flag não está disponível nesta org.',
    noticeCreated: 'Debug flag criada com sucesso.',
    noticeUpdated: 'Debug flag atualizada com sucesso.',
    noticeRemoved: 'Debug flag removida com sucesso.',
    noticeNone: 'Nenhuma trace flag USER_DEBUG encontrada para este alvo.',
    ttlHelper: 'Padrão de 30 minutos. Faixa permitida: 1-1440.',
    managerTitle: 'Gerenciador de DebugLevel',
    managerSubtitle: 'Crie do zero, aplique um preset ou edite um DebugLevel existente campo por campo.',
    managerExisting: 'DebugLevel existente',
    managerNewPlaceholder: 'Novo rascunho',
    managerNew: 'Novo',
    managerPreset: 'Preset',
    managerPresetPlaceholder: 'Selecione um preset',
    managerApplyPreset: 'Aplicar preset',
    managerDeveloperName: 'DeveloperName',
    managerMasterLabel: 'MasterLabel',
    managerLanguage: 'Language',
    managerSave: 'Salvar',
    managerReset: 'Restaurar alterações',
    managerDelete: 'Excluir',
    managerDeleteConfirmPrompt: 'Excluir este DebugLevel da org?',
    managerDeleteConfirmAction: 'Excluir',
    managerDeleteCancel: 'Cancelar',
    managerValidation: 'DeveloperName e MasterLabel são obrigatórios para salvar um DebugLevel.'
  },
  customLogs: {
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
      expectedAnd: 'Trecho inesperado "{token}": junte as condições com "and" e coloque entre aspas os valores com espaços',
      expectedConditionAfterAnd: 'Esperava outra condição depois de "and"',
      serverOperator: '{field} só aceita {allowed}',
      serverLevel: 'Use FINEST, FINER, FINE, DEBUG, INFO, WARN ou ERROR',
      serverSince: 'Use uma duração como 30m, 24h ou 7d, ou uma data ISO',
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
      invalidNote: 'O payload não é um JSON válido. As colunas e os filtros JSON ignoram esta linha. Abra o payload completo para lê-lo.',
      textNote: 'O payload é texto simples, não JSON. As colunas e os filtros JSON ignoram esta linha. Abra o payload completo para lê-lo.',
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
    }
  }
};

export function getMessages(locale?: string): Messages {
  const norm = (locale || 'en').toLowerCase();
  if (norm === 'pt-br' || norm.startsWith('pt-br')) {
    return ptBR;
  }
  if (norm === 'pt' || norm.startsWith('pt')) {
    return ptBR;
  }
  return en;
}
