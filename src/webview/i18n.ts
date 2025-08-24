export type Messages = {
  refresh: string;
  loading: string;
  noLogs: string;
  replay: string;
  open?: string;
  orgLabel: string;
  defaultOrg: string;
  searchPlaceholder?: string;
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
    status: string;
    size: string;
    codeUnitStarted: string;
  };
};

const en: Messages = {
  refresh: 'Refresh',
  loading: 'Loading…',
  noLogs: 'No logs found.',
  replay: 'Apex Replay',
  open: 'Open',
  orgLabel: 'Org',
  defaultOrg: 'Default Org',
  searchPlaceholder: 'Search logs…',
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
    status: 'Status',
    size: 'Size',
    codeUnitStarted: 'Code Unit'
  }
};

const ptBR: Messages = {
  refresh: 'Atualizar',
  loading: 'Carregando…',
  noLogs: 'Nenhum log encontrado.',
  replay: 'Apex Replay',
  open: 'Abrir',
  orgLabel: 'Org',
  defaultOrg: 'Org Padrão',
  searchPlaceholder: 'Buscar logs…',
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
    status: 'Status',
    size: 'Tamanho',
    codeUnitStarted: 'Code Unit'
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
