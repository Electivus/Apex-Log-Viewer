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
    codeUnitStarted: string;
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
    codeUnitStarted: 'Code Unit',
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
    codeUnitStarted: 'Code Unit',
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
