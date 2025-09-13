import assert from 'assert/strict';
import { renderHook, act } from '@testing-library/react';
import useLogFilters from '../webview/hooks/useLogFilters';

suite('useLogFilters', () => {
  test('updates filters and sorting', () => {
    const { result } = renderHook(() => useLogFilters());
    act(() => {
      result.current.setQuery('abc');
      result.current.setFilterUser('user1');
      result.current.setFilterOperation('op1');
      result.current.setFilterStatus('success');
      result.current.setFilterCodeUnit('MyClass');
      result.current.onSort('user');
    });
    assert.equal(result.current.query, 'abc');
    assert.equal(result.current.filterUser, 'user1');
    assert.equal(result.current.filterOperation, 'op1');
    assert.equal(result.current.filterStatus, 'success');
    assert.equal(result.current.filterCodeUnit, 'MyClass');
    assert.equal(result.current.sortBy, 'user');
    assert.equal(result.current.sortDir, 'asc');
    act(() => {
      result.current.onSort('user');
    });
    assert.equal(result.current.sortDir, 'desc');
  });

  test('resets filters without changing sort', () => {
    const { result } = renderHook(() => useLogFilters());
    act(() => {
      result.current.setQuery('abc');
      result.current.setFilterUser('user1');
      result.current.setFilterOperation('op1');
      result.current.setFilterStatus('success');
      result.current.setFilterCodeUnit('MyClass');
      result.current.onSort('user');
      result.current.clearFilters();
    });
    assert.equal(result.current.query, '');
    assert.equal(result.current.filterUser, '');
    assert.equal(result.current.filterOperation, '');
    assert.equal(result.current.filterStatus, '');
    assert.equal(result.current.filterCodeUnit, '');
    assert.equal(result.current.sortBy, 'user');
    assert.equal(result.current.sortDir, 'asc');
  });
});

