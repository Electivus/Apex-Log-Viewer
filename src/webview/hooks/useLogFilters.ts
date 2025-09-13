import { useReducer } from 'react';

export type SortKey =
  | 'user'
  | 'application'
  | 'operation'
  | 'time'
  | 'duration'
  | 'status'
  | 'size'
  | 'codeUnit';

interface State {
  query: string;
  filterUser: string;
  filterOperation: string;
  filterStatus: string;
  filterCodeUnit: string;
  sortBy: SortKey;
  sortDir: 'asc' | 'desc';
}

const initialState: State = {
  query: '',
  filterUser: '',
  filterOperation: '',
  filterStatus: '',
  filterCodeUnit: '',
  sortBy: 'time',
  sortDir: 'desc'
};

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'setQuery':
      return { ...state, query: action.value };
    case 'setFilterUser':
      return { ...state, filterUser: action.value };
    case 'setFilterOperation':
      return { ...state, filterOperation: action.value };
    case 'setFilterStatus':
      return { ...state, filterStatus: action.value };
    case 'setFilterCodeUnit':
      return { ...state, filterCodeUnit: action.value };
    case 'sort':
      if (action.key === state.sortBy) {
        return { ...state, sortDir: state.sortDir === 'asc' ? 'desc' : 'asc' };
      }
      return {
        ...state,
        sortBy: action.key,
        sortDir: action.key === 'time' || action.key === 'size' || action.key === 'duration' ? 'desc' : 'asc'
      };
    case 'reset':
      return {
        ...state,
        query: '',
        filterUser: '',
        filterOperation: '',
        filterStatus: '',
        filterCodeUnit: ''
      };
    default:
      return state;
  }
};

type Action =
  | { type: 'setQuery'; value: string }
  | { type: 'setFilterUser'; value: string }
  | { type: 'setFilterOperation'; value: string }
  | { type: 'setFilterStatus'; value: string }
  | { type: 'setFilterCodeUnit'; value: string }
  | { type: 'sort'; key: SortKey }
  | { type: 'reset' };

export default function useLogFilters() {
  const [state, dispatch] = useReducer(reducer, initialState);

  return {
    ...state,
    setQuery: (value: string) => dispatch({ type: 'setQuery', value }),
    setFilterUser: (value: string) => dispatch({ type: 'setFilterUser', value }),
    setFilterOperation: (value: string) => dispatch({ type: 'setFilterOperation', value }),
    setFilterStatus: (value: string) => dispatch({ type: 'setFilterStatus', value }),
    setFilterCodeUnit: (value: string) => dispatch({ type: 'setFilterCodeUnit', value }),
    onSort: (key: SortKey) => dispatch({ type: 'sort', key }),
    clearFilters: () => dispatch({ type: 'reset' })
  };
}

