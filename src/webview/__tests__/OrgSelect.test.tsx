import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { OrgSelect } from '../components/OrgSelect';
import type { OrgItem } from '../../shared/types';

describe('OrgSelect', () => {
  it('renders options and handles change', async () => {
    const orgs: OrgItem[] = [
      { username: 'u1', alias: 'Org One', isDefaultUsername: true },
      { username: 'u2', alias: 'Two' }
    ];
    const changes: string[] = [];
    const globalDoc = globalThis as unknown as { DocumentFragment: typeof DocumentFragment | undefined };
    const originalDocumentFragment = globalDoc.DocumentFragment;
    // Force native select rendering for simpler interaction testing
    globalDoc.DocumentFragment = undefined;
    try {
      render(
        <OrgSelect label="Org" orgs={orgs} selected={undefined} onChange={v => changes.push(v)} disabled={false} />
      );
      const select = screen.getByRole('combobox') as HTMLSelectElement;
      expect(select.value).toBe('u1');

      fireEvent.change(select, { target: { value: 'u2' } });
      expect(changes).toEqual(['u2']);
    } finally {
      globalDoc.DocumentFragment = originalDocumentFragment;
    }
  });

  it('renders fallback text when no orgs', () => {
    render(
      <OrgSelect label="Org" orgs={[]} selected={undefined} onChange={() => {}} emptyText="No orgs." />
    );
    // No combobox present, fallback span rendered
    const spans = screen.getAllByText(/No orgs\./);
    expect(spans.length).toBeGreaterThanOrEqual(1);
  });
});
