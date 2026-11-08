import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import type {
  CustomLogPayloadColumnsView,
  CustomLogPayloadField,
  CustomLogScalar
} from '@alv/protocol/customLogsTypes';
import type { SortState } from '../../utils/customLogs/columns';
import {
  discoverPayloadFields,
  resolvePayloadColumns,
  sortLoadedRows,
  type DiscoveredField,
  type PayloadColumn
} from '../../utils/customLogs/payloadRows';
import { parseSearch } from '../../utils/customLogs/search';
import type { PayloadUiState } from '../../utils/customLogs/uiState';

export type PayloadWorkbenchOptions<Column extends { id: string }> = {
  initial: PayloadUiState;
  /** The page summaries the host merged, and how many items are loaded. */
  payloadFields: readonly CustomLogPayloadField[];
  itemCount: number;
  columnsView: CustomLogPayloadColumnsView;
  /** The user added or removed a JSON column: the app echoes it into its state and posts the change to the host. */
  onShowColumn: (path: string, shown: boolean) => void;
  /** Must keep its identity while the app's own inputs are the same. */
  buildColumns: (payload: PayloadColumn[], discovered: DiscoveredField[]) => Column[];
};

/**
 * What the list and the entry viewer share over their loaded items: the search, the JSON paths and the
 * columns built from them, and the sort. Each app keeps its own items, standard columns and server-side concerns.
 */
export function usePayloadWorkbench<Column extends { id: string }>({
  initial,
  payloadFields,
  itemCount,
  columnsView,
  onShowColumn,
  buildColumns
}: PayloadWorkbenchOptions<Column>) {
  const [search, setSearch] = useState(initial.search);
  const [sort, setSort] = useState<SortState | undefined>(initial.sort);
  const [hiddenDefaults, setHiddenDefaults] = useState<string[]>(initial.hiddenDefaults);
  // Typing stays responsive over thousands of rows: React matches the last query while the input moves on.
  const deferredSearch = useDeferredValue(search);
  const terms = useMemo(() => parseSearch(deferredSearch), [deferredSearch]);

  const discovered = useMemo(() => discoverPayloadFields(payloadFields, itemCount), [payloadFields, itemCount]);
  const payloadColumns = useMemo(
    () => resolvePayloadColumns(columnsView, hiddenDefaults),
    [columnsView, hiddenDefaults]
  );
  const activeColumns = useMemo(() => new Set(payloadColumns.map(column => column.path)), [payloadColumns]);
  const lockedColumns = useMemo(
    () => new Set(payloadColumns.filter(column => column.origin === 'default').map(column => column.path)),
    [payloadColumns]
  );
  const columns = useMemo(() => buildColumns(payloadColumns, discovered), [buildColumns, discovered, payloadColumns]);
  // The sort is kept and saved as chosen, and applies while its column is shown: a restored webview gets its
  // columns from the host after it mounts, so an absent column is not a reason to forget the sort.
  const sortColumn = sort ? columns.find(column => column.id === sort.columnId) : undefined;
  const appliedSort = sortColumn ? sort : undefined;

  const uiState = useMemo<PayloadUiState>(() => ({ search, sort, hiddenDefaults }), [hiddenDefaults, search, sort]);

  const toggleColumn = useCallback(
    (path: string) => {
      if (columnsView.defaults.includes(path)) {
        setHiddenDefaults(previous =>
          previous.includes(path) ? previous.filter(hidden => hidden !== path) : [...previous, path]
        );
        return;
      }
      onShowColumn(path, !columnsView.added.includes(path));
    },
    [columnsView, onShowColumn]
  );

  const removeColumn = useCallback(
    (path: string) => {
      if (activeColumns.has(path)) {
        toggleColumn(path);
      }
    },
    [activeColumns, toggleColumn]
  );

  const onSort = useCallback((columnId: string, dir?: 'asc' | 'desc') => {
    setSort(previous => {
      if (dir) {
        return { columnId, dir };
      }
      if (previous?.columnId !== columnId) {
        return { columnId, dir: 'asc' };
      }
      return previous.dir === 'asc' ? { columnId, dir: 'desc' } : undefined;
    });
  }, []);

  const sortItems = useCallback(
    <T>(items: readonly T[], valueOf: (item: T, column: Column) => CustomLogScalar | undefined): readonly T[] =>
      sort && sortColumn ? sortLoadedRows(items, item => valueOf(item, sortColumn), sort.dir) : items,
    [sort, sortColumn]
  );

  /** A different org or source: its rows have nothing to do with this search, sort or hidden columns. */
  const reset = useCallback(() => {
    setSearch('');
    setSort(undefined);
    setHiddenDefaults([]);
  }, []);

  return {
    discovered,
    payloadColumns,
    activeColumns,
    lockedColumns,
    columns,
    search,
    setSearch,
    terms,
    payloadInUse: terms.length > 0 || payloadColumns.length > 0 || appliedSort !== undefined,
    sort: appliedSort,
    onSort,
    sortItems,
    toggleColumn,
    removeColumn,
    uiState,
    reset
  };
}
