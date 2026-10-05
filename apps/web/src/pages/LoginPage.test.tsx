import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PublicUser } from '@vyuha/shared';
import { ApiRequestError } from '@/lib/api';

const login = vi.fn();
let current: PublicUser | null = null;
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ user: current, status: 'ready', login, logout: vi.fn() }),
}));

import { RequireRole } from '@/auth/guards';
import { LandingPage } from './LandingPage';
import { LoginChooserPage } from './LoginChooserPage';
import { LoginPage } from './LoginPage';

const instructor: PublicUser = { id: 'i', name: 'Col', email: 'i@x.io', role: 'INSTRUCTOR' };
const trainee: PublicUser = { id: 't', name: 'Asha', email: 't@x.io', role: 'TRAINEE' };

function app(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginChooserPage />} />
        <Route path="/login/instructor" element={<LoginPage portal="INSTRUCTOR" />} />
        <Route path="/login/trainee" element={<LoginPage portal="TRAINEE" />} />
        <Route path="/register" element={<p>register page</p>} />
        <Route path="/instructor" element={<p>instructor home</p>} />
        <Route path="/trainee" element={<p>trainee home</p>} />
        <Route element={<RequireRole role="INSTRUCTOR" />}>
          <Route path="/instructor-only" element={<p>secret instructor page</p>} />
        </Route>
        <Route element={<RequireRole role="TRAINEE" />}>
          <Route path="/trainee-only" element={<p>secret trainee page</p>} />
        </Route>
        <Route element={<RequireRole />}>
          <Route path="/any-user" element={<p>any user page</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

async function fill(email: string, password: string) {
  await userEvent.type(screen.getByLabelText('Email'), email);
  await userEvent.type(screen.getByLabelText('Password'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

beforeEach(() => {
  login.mockReset();
  current = null;
});

describe('two sign-in options', () => {
  it('shows an instructor login and a trainee login on the home page and on /login', () => {
    for (const path of ['/', '/login']) {
      const { unmount } = app(path);
      const main = within(screen.getByRole('main'));
      expect(main.getByRole('link', { name: 'Instructor login' })).toHaveAttribute(
        'href',
        '/login/instructor',
      );
      expect(main.getByRole('link', { name: 'Trainee login' })).toHaveAttribute(
        'href',
        '/login/trainee',
      );
      expect(main.getByRole('link', { name: 'Create a trainee account' })).toHaveAttribute(
        'href',
        '/register',
      );
      unmount();
    }
  });

  it('offers both logins in the menu to a visitor', () => {
    app('/');
    const menu = within(screen.getByRole('navigation', { name: 'Main menu' }));
    expect(menu.getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Home',
      'Instructor login',
      'Trainee login',
      'Create a trainee account',
    ]);
  });

  it('signs an instructor in through the instructor portal and sends the portal to the server', async () => {
    login.mockResolvedValue(instructor);
    app('/login/instructor');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Instructor sign in');
    // no self-registration for instructors
    expect(screen.getByText(/no self-registration/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create an account' })).not.toBeInTheDocument();
    await fill('i@x.io', 'Vyuha@123');
    expect(login).toHaveBeenCalledWith({
      email: 'i@x.io',
      password: 'Vyuha@123',
      portal: 'INSTRUCTOR',
    });
    expect(await screen.findByText('instructor home')).toBeInTheDocument();
  });

  it('signs a trainee in through the trainee portal and offers account creation', async () => {
    login.mockResolvedValue(trainee);
    app('/login/trainee');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Trainee sign in');
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/register',
    );
    await fill('t@x.io', 'Vyuha@123');
    expect(login).toHaveBeenCalledWith({
      email: 't@x.io',
      password: 'Vyuha@123',
      portal: 'TRAINEE',
    });
    expect(await screen.findByText('trainee home')).toBeInTheDocument();
  });

  it('tells a person who used the wrong portal where to go, and links to the other one', async () => {
    login.mockRejectedValue(new ApiRequestError('no', 403, 'FORBIDDEN'));
    app('/login/instructor');
    await fill('t@x.io', 'Vyuha@123');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This is not an instructor account. Trainees should use the trainee login.',
    );
    expect(
      within(screen.getByRole('main')).getByRole('link', { name: 'Trainee login' }),
    ).toHaveAttribute('href', '/login/trainee');
  });

  it('drops the old server message when the next attempt fails the form checks', async () => {
    login.mockRejectedValue(new ApiRequestError('no', 403, 'FORBIDDEN'));
    app('/login/instructor');
    await fill('t@x.io', 'Vyuha@123');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Email'));
    await userEvent.clear(screen.getByLabelText('Password'));
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Password is required')).toBeInTheDocument();
    expect(screen.queryByText(/not an instructor account/)).not.toBeInTheDocument();
  });

  it('shows a working demo email and password on each sign-in page', () => {
    const first = app('/login/instructor');
    const box = within(screen.getByRole('complementary'));
    expect(box.getByText('instructor@vyuha.local')).toBeInTheDocument();
    expect(box.getByText('Vyuha@123')).toBeInTheDocument();
    first.unmount();
    app('/login/trainee');
    expect(
      within(screen.getByRole('complementary')).getByText('trainee1@vyuha.local'),
    ).toBeInTheDocument();
  });

  it('fills in the demo login and signs in with it', async () => {
    login.mockResolvedValue(instructor);
    app('/login/instructor');
    await userEvent.click(screen.getByRole('button', { name: 'Fill in the demo login' }));
    expect(screen.getByLabelText('Email')).toHaveValue('instructor@vyuha.local');
    expect(screen.getByLabelText('Password')).toHaveValue('Vyuha@123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(login).toHaveBeenCalledWith({
      email: 'instructor@vyuha.local',
      password: 'Vyuha@123',
      portal: 'INSTRUCTOR',
    });
    expect(await screen.findByText('instructor home')).toBeInTheDocument();
  });

  it('shows the normal message for a wrong password', async () => {
    login.mockRejectedValue(new ApiRequestError('bad', 401, 'INVALID_CREDENTIALS'));
    app('/login/trainee');
    await fill('t@x.io', 'wrong-password');
    expect(await screen.findByRole('alert')).toHaveTextContent(/incorrect/i);
  });

  it('sends a signed-out visitor to the sign-in that matches the page they asked for', () => {
    app('/instructor-only');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Instructor sign in');
  });

  it('sends a visitor to the trainee sign-in, or the chooser, for the other pages', () => {
    const first = app('/trainee-only');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Trainee sign in');
    first.unmount();
    app('/any-user');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Choose how to sign in');
  });

  it('keeps a trainee out of instructor pages and the reverse', () => {
    current = trainee;
    const first = app('/instructor-only');
    expect(screen.getByText('trainee home')).toBeInTheDocument();
    first.unmount();
    current = instructor;
    app('/trainee-only');
    expect(screen.getByText('instructor home')).toBeInTheDocument();
  });
});
