import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { PublicUser } from '@vyuha/shared';
import { TEXT_SIZE_PERCENTS, DEFAULT_TEXT_SIZE_INDEX } from '@/lib/displayPrefs';

let user: PublicUser | null = null;
const logout = vi.fn();
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ user, status: 'ready', logout }),
}));

import { AppFooter } from './AppFooter';
import { AppHeader } from './AppHeader';

const instructor: PublicUser = { id: 'i', name: 'Col. Rao', email: 'i@x.io', role: 'INSTRUCTOR' };
const trainee: PublicUser = { id: 't', name: 'Asha', email: 't@x.io', role: 'TRAINEE' };

const renderHeader = (compact = false) =>
  render(
    <MemoryRouter initialEntries={['/instructor']}>
      <AppHeader compact={compact} />
      <main>content</main>
    </MemoryRouter>,
  );

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.style.fontSize = '';
  document.documentElement.classList.remove('hc');
  logout.mockReset();
});
afterEach(() => {
  user = null;
});

describe('portal header', () => {
  it('shows the service name, purpose and a main menu', () => {
    renderHeader();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByText('Virtual Yuddh-abhyas Under Hampered Awareness')).toBeInTheDocument();
    expect(
      screen.getByText('Decision-making trainer for degraded communication environments'),
    ).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main menu' })).toBeInTheDocument();
  });

  it('offers visitors Home, the two logins and account creation', () => {
    renderHeader();
    const menu = within(screen.getByRole('navigation', { name: 'Main menu' }));
    expect(menu.getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Home',
      'Instructor login',
      'Trainee login',
      'Create a trainee account',
    ]);
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });

  it('gives each role its own menu and a visible Sign out', async () => {
    user = instructor;
    const { unmount } = renderHeader();
    let menu = within(screen.getByRole('navigation', { name: 'Main menu' }));
    expect(menu.getByRole('link', { name: 'Scenarios and sessions' })).toHaveAttribute(
      'href',
      '/instructor',
    );
    expect(menu.getByRole('link', { name: 'Trainee progress' })).toHaveAttribute(
      'href',
      '/progress',
    );
    expect(screen.getByText('Col. Rao')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(logout).toHaveBeenCalledOnce();
    unmount();

    user = trainee;
    renderHeader();
    menu = within(screen.getByRole('navigation', { name: 'Main menu' }));
    expect(menu.getByRole('link', { name: 'Join an exercise' })).toHaveAttribute(
      'href',
      '/trainee',
    );
    expect(menu.getByRole('link', { name: 'My progress' })).toHaveAttribute('href', '/progress');
  });

  it('marks the current page in the menu', () => {
    user = instructor;
    renderHeader();
    expect(screen.getByRole('link', { name: 'Scenarios and sessions' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Trainee progress' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('has a skip link that moves focus to the main content', async () => {
    renderHeader();
    await userEvent.click(screen.getByRole('link', { name: 'Skip to main content' }));
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('keeps one slim row, without the menu, in the compact cockpit variant', () => {
    user = trainee;
    renderHeader(true);
    expect(screen.queryByRole('navigation', { name: 'Main menu' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Text size' })).toBeInTheDocument();
  });
});

describe('reader controls', () => {
  it('make the text larger or smaller, stop at the limits, and remember the choice', async () => {
    renderHeader();
    const root = document.documentElement;
    const pct = (i: number) => `${TEXT_SIZE_PERCENTS[i]}%`;
    const bigger = screen.getByRole('button', { name: 'Increase text size' });
    const smaller = screen.getByRole('button', { name: 'Decrease text size' });
    await vi.waitFor(() => expect(root.style.fontSize).toBe(pct(DEFAULT_TEXT_SIZE_INDEX)));

    await userEvent.click(bigger);
    expect(root.style.fontSize).toBe(pct(DEFAULT_TEXT_SIZE_INDEX + 1));
    await userEvent.click(bigger);
    expect(root.style.fontSize).toBe(pct(TEXT_SIZE_PERCENTS.length - 1));
    expect(bigger).toBeDisabled();
    expect(window.localStorage.getItem('vyuha.textSize')).toBe(
      String(TEXT_SIZE_PERCENTS.length - 1),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Default text size' }));
    expect(root.style.fontSize).toBe(pct(DEFAULT_TEXT_SIZE_INDEX));
    await userEvent.click(smaller);
    await userEvent.click(smaller);
    expect(smaller).toBeDisabled();
    expect(root.style.fontSize).toBe(pct(0));
  });

  it('switch high contrast on and off', async () => {
    renderHeader();
    const toggle = screen.getByRole('button', { name: 'High contrast' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.classList.contains('hc')).toBe(true);
    expect(window.localStorage.getItem('vyuha.contrast')).toBe('true');
    await userEvent.click(toggle);
    expect(document.documentElement.classList.contains('hc')).toBe(false);
  });

  it('start from what was saved in this browser', () => {
    window.localStorage.setItem('vyuha.textSize', '4');
    window.localStorage.setItem('vyuha.contrast', 'true');
    renderHeader();
    expect(document.documentElement.style.fontSize).toBe(`${TEXT_SIZE_PERCENTS[4]}%`);
    expect(document.documentElement.classList.contains('hc')).toBe(true);
  });
});

describe('portal footer', () => {
  it('says what the site is and that it is not an official government website', () => {
    render(<AppFooter />);
    const footer = within(screen.getByRole('contentinfo'));
    expect(footer.getByText(/not an official government website/)).toBeInTheDocument();
    expect(footer.getByText(/OpenStreetMap contributors/)).toBeInTheDocument();
  });
});
