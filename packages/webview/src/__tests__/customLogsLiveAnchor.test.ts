import { anchoredScrollTop } from '../components/custom-logs/useLiveAnchor';

const ROW = 24;
const rowsOf = (...ids: string[]) => ids.map(id => ({ id }));

describe('anchoredScrollTop', () => {
  const loaded = rowsOf('e', 'd', 'c', 'b', 'a');

  it('moves down by the height of the rows inserted above the first visible one', () => {
    expect(
      anchoredScrollTop({
        previous: loaded,
        rows: rowsOf('g', 'f', ...loaded.map(r => r.id)),
        scrollTop: 2 * ROW,
        rowHeight: ROW
      })
    ).toBe(4 * ROW);
  });

  it('keeps the part of a row that is scrolled out of view', () => {
    expect(
      anchoredScrollTop({
        previous: loaded,
        rows: rowsOf('f', ...loaded.map(r => r.id)),
        scrollTop: 2 * ROW + 9,
        rowHeight: ROW
      })
    ).toBe(3 * ROW + 9);
  });

  it('follows the new rows at the top', () => {
    expect(
      anchoredScrollTop({ previous: loaded, rows: rowsOf('f', ...loaded.map(r => r.id)), scrollTop: 0, rowHeight: ROW })
    ).toBeUndefined();
  });

  it('does not move for rows inserted below the first visible one', () => {
    expect(
      anchoredScrollTop({
        previous: loaded,
        rows: rowsOf('e', 'd', 'cc', 'c', 'b', 'a'),
        scrollTop: ROW,
        rowHeight: ROW
      })
    ).toBeUndefined();
  });

  it('counts only the rows inserted above it when others land below', () => {
    expect(
      anchoredScrollTop({
        previous: loaded,
        rows: rowsOf('f', 'e', 'd', 'c', 'bb', 'b', 'a'),
        scrollTop: 2 * ROW,
        rowHeight: ROW
      })
    ).toBe(3 * ROW);
  });

  it('does not move when the first visible row is gone', () => {
    expect(
      anchoredScrollTop({ previous: loaded, rows: rowsOf('f', 'e', 'd', 'b', 'a'), scrollTop: 2 * ROW, rowHeight: ROW })
    ).toBeUndefined();
  });

  it('does not move when the rows were reordered, as a sort does', () => {
    expect(
      anchoredScrollTop({ previous: loaded, rows: rowsOf('a', 'b', 'c', 'd', 'e'), scrollTop: 2 * ROW, rowHeight: ROW })
    ).toBeUndefined();
  });

  it('does not move when a filter removed rows above the first visible one and live rows came in', () => {
    expect(
      anchoredScrollTop({ previous: loaded, rows: rowsOf('f', 'c', 'b', 'a'), scrollTop: 2 * ROW, rowHeight: ROW })
    ).toBeUndefined();
  });

  it('does not move when nothing was loaded before', () => {
    expect(anchoredScrollTop({ previous: [], rows: loaded, scrollTop: 48, rowHeight: ROW })).toBeUndefined();
  });

  it('anchors on the last row when the offset is past the end of the old list', () => {
    expect(
      anchoredScrollTop({
        previous: loaded,
        rows: rowsOf('f', ...loaded.map(r => r.id)),
        scrollTop: 99 * ROW,
        rowHeight: ROW
      })
    ).toBe(99 * ROW + ROW);
  });
});
