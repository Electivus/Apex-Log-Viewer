import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  CustomLogPayloadColumnsView,
  CustomLogPayloadField,
  CustomLogScalar
} from '@alv/protocol/customLogsTypes';
import type { SortState } from '../../utils/customLogs/columns';
import {
  filterConditionsEqual,
  formatFilterCondition,
  formatFilterField,
  formatFilterValue,
  type FilterClause
} from '../../utils/customLogs/filterGrammar';
import {
  discoverPayloadFields,
  resolvePayloadColumns,
  sortLoadedRows,
  type DiscoveredField,
  type PayloadColumn
} from '../../utils/customLogs/payloadRows';
import type { PayloadUiState } from '../../utils/customLogs/uiState';
import type { FilterBarPrefill, FilterChip } from './CustomLogsFilterBar';

export type PayloadWorkbenchOptions<Column extends { id: string }> = {
  initial: PayloadUiState;
  /** The page summaries the host merged, and how many items are loaded. */
  payloadFields: readonly CustomLogPayloadField[];
  itemCount: number;
  columnsView: CustomLogPayloadColumnsView;
  /** The user added or removed a JSON column: the app echoes it into its state and posts it to the host. */
  onAddedColumns: (added: string[]) => void;
  /** Must keep its identity while the app's own inputs are the same. */
  buildColumns: (payload: PayloadColumn[], discovered: DiscoveredField[]) => Column[];
};

/**
 * What the list and the entry viewer share around a JSON payload: the discovered paths, the columns built
 * from them, the loaded-rows filters, the sort, and the prefill the filter bar takes from a column menu.
 * Each app keeps its own items, standard columns and server-side concerns.
 */
export function usePayloadWorkbench<Column extends { id: string }>({
  initial,
  payloadFields,
  itemCount,
  columnsView,
  onAddedColumns,
  buildColumns
}: PayloadWorkbenchOptions<Column>) {
  const [payloadFilters, setPayloadFilters] = useState<FilterClause[]>(initial.payloadFilters);
  const [sort, setSort] = useState<SortState | undefined>(initial.sort);
  const [hiddenDefaults, setHiddenDefaults] = useState<string[]>(initial.hiddenDefaults);
  const [prefill, setPrefill] = useState<FilterBarPrefill | undefined>(undefined);
  const prefillNonce = useRef(0);

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

  const uiState = useMemo<PayloadUiState>(
    () => ({ payloadFilters, sort, hiddenDefaults }),
    [hiddenDefaults, payloadFilters, sort]
  );

  const addPayloadFilters = useCallback((clauses: readonly FilterClause[]) => {
    setPayloadFilters(previous => {
      const next = [...previous];
      for (const clause of clauses) {
        if (!next.some(existing => filterConditionsEqual(existing, clause))) {
          next.push(clause);
        }
      }
      return next.length === previous.length ? previous : next;
    });
  }, []);

  const filterEqual = useCallback(
    (path: string, value: CustomLogScalar) =>
      addPayloadFilters([{ field: path, op: '=', value: value === null ? 'null' : String(value) }]),
    [addPayloadFilters]
  );

  const loadedChips = useMemo<FilterChip[]>(
    () =>
      payloadFilters.map((clause, index) => {
        const remove = () => setPayloadFilters(previous => previous.filter((_, position) => position !== index));
        return {
          key: `loaded-${index}-${formatFilterCondition(clause, 'payload')}`,
          scope: 'loaded' as const,
          text: formatFilterCondition(clause, 'payload'),
          field: formatFilterField(clause.field, 'payload'),
          op: clause.op,
          ...(clause.value === undefined ? {} : { value: formatFilterValue(clause.value) }),
          onRemove: remove,
          onEdit: () => {
            remove();
            return formatFilterCondition(clause, 'payload');
          }
        };
      }),
    [payloadFilters]
  );

  const toggleColumn = useCallback(
    (path: string) => {
      if (columnsView.defaults.includes(path)) {
        setHiddenDefaults(previous =>
          previous.includes(path) ? previous.filter(hidden => hidden !== path) : [...previous, path]
        );
        return;
      }
      onAddedColumns(
        columnsView.added.includes(path)
          ? columnsView.added.filter(column => column !== path)
          : [...columnsView.added, path]
      );
    },
    [columnsView, onAddedColumns]
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
    <T>(items: T[], valueOf: (item: T, column: Column) => CustomLogScalar | undefined): T[] =>
      sort && sortColumn ? sortLoadedRows(items, item => valueOf(item, sortColumn), sort.dir) : items,
    [sort, sortColumn]
  );

  /** Moves the filter bar to `path`, written as the grammar reads it back, ready for an operator. */
  const prefillFilterField = useCallback((path: string) => {
    prefillNonce.current += 1;
    setPrefill({ text: `${formatFilterField(path, 'payload')} `, nonce: prefillNonce.current });
  }, []);

  /** A different org or source: its rows have nothing to do with these filters, sort or hidden columns. */
  const reset = useCallback(() => {
    setPayloadFilters([]);
    setSort(undefined);
    setHiddenDefaults([]);
  }, []);

  return {
    discovered,
    payloadColumns,
    activeColumns,
    lockedColumns,
    columns,
    payloadFilters,
    filtering: payloadFilters.length > 0,
    payloadInUse: payloadFilters.length > 0 || payloadColumns.length > 0 || appliedSort !== undefined,
    loadedChips,
    addPayloadFilters,
    filterEqual,
    sort: appliedSort,
    onSort,
    sortItems,
    toggleColumn,
    removeColumn,
    prefill,
    prefillFilterField,
    uiState,
    reset
  };
}
