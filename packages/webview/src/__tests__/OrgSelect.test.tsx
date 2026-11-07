import React from 'react';
import { render, fireEvent, screen, within } from '@testing-library/react';
import { OrgSelect } from '../components/OrgSelect';
import type { OrgItem } from '@alv/protocol/types';

const fewOrgs: OrgItem[] = [
  { username: 'u1@example.com', alias: 'Org One', isDefaultUsername: true },
  { username: 'u2@example.com', alias: 'Two' },
  { username: 'u3@example.com' }
];

const manyOrgs: OrgItem[] = Array.from({ length: 12 }, (_, i) => ({
  username: `user${i + 1}@example.com`,
  alias: i % 4 === 3 ? undefined : `Sandbox ${i + 1}`
}));

function renderPicker(
  orgs: OrgItem[],
  selected: string | undefined,
  props: Partial<React.ComponentProps<typeof OrgSelect>> = {}
) {
  const changes: string[] = [];
  render(<OrgSelect label="Org" orgs={orgs} selected={selected} onChange={v => changes.push(v)} {...props} />);
  return { changes, trigger: () => screen.getByRole('combobox') };
}

describe('OrgSelect', () => {
  afterEach(() => {
    document.documentElement.lang = '';
  });

  it('shows the selected alias on the trigger and falls back to the username', () => {
    renderPicker(fewOrgs, 'u1@example.com');
    expect(screen.getByRole('combobox')).toHaveTextContent('Org One');
  });

  it('keeps the test id on the trigger', () => {
    renderPicker(fewOrgs, 'u2@example.com', { testId: 'org-picker' });
    expect(screen.getByTestId('org-picker')).toBe(screen.getByRole('combobox'));
  });

  it('lists each org as an option with the alias first and the username after it', () => {
    const { trigger } = renderPicker(fewOrgs, 'u1@example.com');
    fireEvent.click(trigger());

    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map(o => o.textContent)).toEqual(['Org Oneu1@example.com', 'Twou2@example.com', 'u3@example.com']);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-selected', 'false');
  });

  it('exposes combobox state to assistive technology', () => {
    const { trigger } = renderPicker(fewOrgs, 'u1@example.com');
    expect(trigger()).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger());

    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(trigger().getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
    expect(screen.getByRole('listbox')).toHaveAccessibleName('Org');
  });

  it('chooses an org by click and closes', () => {
    const { changes, trigger } = renderPicker(fewOrgs, 'u1@example.com');
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: /Two/ }));

    expect(changes).toEqual(['u2@example.com']);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does not report a choice of the org that is already selected', () => {
    const { changes, trigger } = renderPicker(fewOrgs, 'u1@example.com');
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: /Org One/ }));

    expect(changes).toEqual([]);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('hides the search box for five orgs or fewer', () => {
    const five = manyOrgs.slice(0, 5);
    const { trigger } = renderPicker(five, five[0]!.username);
    fireEvent.click(trigger());

    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('shows the search box for more than five orgs and focuses it on open', () => {
    const { trigger } = renderPicker(manyOrgs, 'user1@example.com');
    fireEvent.click(trigger());

    expect(screen.getByRole('searchbox')).toHaveFocus();
  });

  it('focuses the list on open when there is no search box', () => {
    const { trigger } = renderPicker(fewOrgs, 'u1@example.com');
    fireEvent.click(trigger());

    expect(screen.getByRole('listbox')).toHaveFocus();
  });

  it('filters by alias and by username, and reports when nothing matches', () => {
    const { trigger } = renderPicker(manyOrgs, 'user1@example.com');
    fireEvent.click(trigger());
    const search = screen.getByRole('searchbox');

    fireEvent.change(search, { target: { value: 'sandbox 11' } });
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['Sandbox 11user11@example.com']);

    fireEvent.change(search, { target: { value: 'user4@' } });
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['user4@example.com']);

    fireEvent.change(search, { target: { value: 'nothing like this' } });
    expect(screen.queryAllByRole('option')).toEqual([]);
    expect(screen.getByRole('status')).toHaveTextContent('No orgs match.');
  });

  it('moves with the arrow keys and chooses with Enter', () => {
    const { changes, trigger } = renderPicker(manyOrgs, 'user1@example.com');
    fireEvent.click(trigger());
    const search = screen.getByRole('searchbox');
    expect(search).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0]!.id);

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[2]!.id);
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(changes).toEqual(['user2@example.com']);
  });

  it('chooses the first match after typing a query and pressing Enter', () => {
    const { changes, trigger } = renderPicker(manyOrgs, 'user1@example.com');
    fireEvent.click(trigger());
    const search = screen.getByRole('searchbox');

    fireEvent.change(search, { target: { value: 'sandbox 9' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(changes).toEqual(['user9@example.com']);
  });

  it('does not choose an org when Enter confirms an IME composition', () => {
    const { changes, trigger } = renderPicker(manyOrgs, 'user1@example.com');
    fireEvent.click(trigger());
    const search = screen.getByRole('searchbox');

    fireEvent.change(search, { target: { value: 'sandbox 9' } });
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true });

    expect(changes).toEqual([]);
    expect(search).toBeInTheDocument();
  });

  it('starts on the selected org and stays within the list at its ends', () => {
    const { trigger } = renderPicker(fewOrgs, 'u2@example.com');
    fireEvent.click(trigger());
    const list = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    expect(list).toHaveAttribute('aria-activedescendant', options[1]!.id);

    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(list).toHaveAttribute('aria-activedescendant', options[2]!.id);
    fireEvent.keyDown(list, { key: 'Home' });
    expect(list).toHaveAttribute('aria-activedescendant', options[0]!.id);
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(list).toHaveAttribute('aria-activedescendant', options[0]!.id);
  });

  it('closes on Escape without choosing', () => {
    const { changes, trigger } = renderPicker(manyOrgs, 'user1@example.com');
    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(changes).toEqual([]);
  });

  it('opens from the trigger with the arrow keys', () => {
    const { trigger } = renderPicker(fewOrgs, 'u1@example.com');
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });

    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('clears the query each time it opens', () => {
    const { trigger } = renderPicker(manyOrgs, 'user1@example.com');
    fireEvent.click(trigger());
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'sandbox 2' } });
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    fireEvent.click(trigger());

    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getAllByRole('option')).toHaveLength(manyOrgs.length);
  });

  it('does not open while disabled', () => {
    const { trigger } = renderPicker(fewOrgs, 'u1@example.com', { disabled: true });
    fireEvent.click(trigger());

    expect(trigger()).toBeDisabled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('labels the search box in the page language', () => {
    document.documentElement.lang = 'pt-BR';
    const { trigger } = renderPicker(manyOrgs, 'user1@example.com');
    fireEvent.click(trigger());

    expect(screen.getByRole('searchbox')).toHaveAccessibleName('Buscar orgs…');
  });

  it('lets the caller place the label inline', () => {
    const { trigger } = renderPicker(fewOrgs, 'u1@example.com', { className: 'min-w-0 flex-row items-center gap-2' });
    const wrapper = trigger().parentElement!;

    expect(wrapper).toHaveClass('flex-row', 'min-w-0');
    expect(wrapper).not.toHaveClass('flex-col');
  });

  it('renders fallback text when there are no orgs', () => {
    render(<OrgSelect label="Org" orgs={[]} selected={undefined} onChange={() => {}} emptyText="No orgs." />);

    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('No orgs.')).toBeInTheDocument();
  });
});
