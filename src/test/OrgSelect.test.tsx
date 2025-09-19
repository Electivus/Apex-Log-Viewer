import assert from 'assert/strict';
import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { OrgSelect } from '../webview/components/OrgSelect';
import type { OrgItem } from '../shared/types';

suite('OrgSelect', () => {
  test('renders options and handles change', async () => {
    const orgs: OrgItem[] = [
      { username: 'u1', alias: 'Org One', isDefaultUsername: true } as any,
      { username: 'u2', alias: 'Two' } as any
    ];
    const changes: string[] = [];
    render(
      <OrgSelect label="Org" orgs={orgs} selected={undefined} onChange={v => changes.push(v)} disabled={false} />
    );
    const select = screen.getByRole('combobox', { name: /Org/i }) as HTMLSelectElement;
    assert.equal(select.value, 'u1');
    fireEvent.change(select, { target: { value: 'u2' } });
    assert.deepEqual(changes, ['u2']);
  });

  test('renders fallback text when no orgs', () => {
    render(
      <OrgSelect label="Org" orgs={[]} selected={undefined} onChange={() => {}} emptyText="No orgs." />
    );
    // No combobox present, fallback span rendered
    const spans = screen.getAllByText(/No orgs\./);
    assert.ok(spans.length >= 1);
  });
});

