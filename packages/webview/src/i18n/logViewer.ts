export type LogViewerMessages = {
  title: string;
  searchPlaceholder: string;
  previousMatch: string;
  nextMatch: string;
  viewRaw: string;
  filters: string;
  debugOnly: string;
  errors: string;
  showing: string;
  entriesOne: string;
  entriesOther: string;
  loadingEntries: string;
  loadFailed: string;
  fetchUnavailable: string;
  noEntriesMatch: string;
  status: {
    totalLines: string;
    size: string;
    updated: string;
    loading: string;
    failed: string;
    ready: string;
  };
  failure: { label: string; goToError: string };
  diagnostics: {
    title: string;
    total: string;
    all: string;
    errors: string;
    warnings: string;
    loading: string;
    unavailable: string;
    none: string;
    summary: string;
    line: string;
    unmapped: string;
    severity: { error: string; warning: string };
  };
};

export const logViewerEn: LogViewerMessages = {
  title: 'Apex Log Viewer',
  searchPlaceholder: 'Search entries…',
  previousMatch: 'Previous match',
  nextMatch: 'Next match',
  viewRaw: 'View Raw',
  filters: 'Filters:',
  debugOnly: 'Debug Only',
  errors: 'Errors',
  showing: 'Showing:',
  entriesOne: '{count} entry',
  entriesOther: '{count} entries',
  loadingEntries: 'Loading log entries…',
  loadFailed: 'Failed to load log content: {error}',
  fetchUnavailable: 'Fetch API unavailable',
  noEntriesMatch: 'No entries match the current filters.',
  status: {
    totalLines: 'Total Lines: {count}',
    size: 'Size: {size}',
    updated: 'Updated: {date}',
    loading: 'Loading…',
    failed: 'Not loaded',
    ready: 'Ready'
  },
  failure: { label: 'Failure', goToError: 'Go to error' },
  diagnostics: {
    title: 'Diagnostics',
    total: '{count} total',
    all: 'All',
    errors: 'Errors',
    warnings: 'Warnings',
    loading: 'Loading diagnostics…',
    unavailable: 'Diagnostics unavailable.',
    none: 'No diagnostics found.',
    summary: 'Summary',
    line: 'Line {line}',
    unmapped: 'Unmapped',
    severity: { error: 'error', warning: 'warning' }
  }
};

export const logViewerPtBR: LogViewerMessages = {
  title: 'Apex Log Viewer',
  searchPlaceholder: 'Buscar entradas…',
  previousMatch: 'Ocorrência anterior',
  nextMatch: 'Próxima ocorrência',
  viewRaw: 'Ver bruto',
  filters: 'Filtros:',
  debugOnly: 'Somente debug',
  errors: 'Erros',
  showing: 'Exibindo:',
  entriesOne: '{count} entrada',
  entriesOther: '{count} entradas',
  loadingEntries: 'Carregando entradas do log…',
  loadFailed: 'Falha ao carregar o conteúdo do log: {error}',
  fetchUnavailable: 'Fetch API indisponível',
  noEntriesMatch: 'Nenhuma entrada corresponde aos filtros atuais.',
  status: {
    totalLines: 'Total de linhas: {count}',
    size: 'Tamanho: {size}',
    updated: 'Atualizado: {date}',
    loading: 'Carregando…',
    failed: 'Não carregado',
    ready: 'Pronto'
  },
  failure: { label: 'Falha', goToError: 'Ir para o erro' },
  diagnostics: {
    title: 'Diagnósticos',
    total: '{count} no total',
    all: 'Todos',
    errors: 'Erros',
    warnings: 'Avisos',
    loading: 'Carregando diagnósticos…',
    unavailable: 'Diagnósticos indisponíveis.',
    none: 'Nenhum diagnóstico encontrado.',
    summary: 'Resumo',
    line: 'Linha {line}',
    unmapped: 'Sem linha',
    severity: { error: 'erro', warning: 'aviso' }
  }
};
