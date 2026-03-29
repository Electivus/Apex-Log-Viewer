import React from 'react';
import { render, screen } from '@testing-library/react';

import { Input } from '../components/ui/input';

describe('Input component', () => {
  it('renders default text input', () => {
    render(<Input placeholder="Default" />);
    const input = screen.getByPlaceholderText('Default') as HTMLInputElement;
    expect(input.type).toBe('text');
  });

  it('respects provided type attribute', () => {
    render(<Input placeholder="Search" type="search" />);
    const input = screen.getByPlaceholderText('Search') as HTMLInputElement;
    expect(input.type).toBe('search');
  });
});
