import { useState, useEffect, useCallback } from 'react';
import { Button, FieldError, Input, Label, TextField, Typography } from '@heroui/react';
import { apiFetch } from './lib/api';

/**
 * The marketing site sends visitors here after an anonymous voice demo as
 * `?claim=demo-<uuid>` — the id of the throwaway users row their demo
 * session wrote to. Signing up with one present claims that row instead of
 * creating a fresh one, so the vocabulary and transcript from the demo
 * survive into the real account.
 */
function pendingClaimId(): string | null {
  const id = new URLSearchParams(window.location.search).get('claim');
  return id && id.startsWith('demo-') ? id : null;
}

function clearClaimParam() {
  const url = new URL(window.location.href);
  url.searchParams.delete('claim');
  window.history.replaceState({}, '', url.toString());
}

/** Check if we're authenticated by hitting a protected endpoint. */
function useAuth() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    // 2026-07-16: was checking /api/stats, which has no requireAuth gate at
    // all (always 200) — authed was always resolving true regardless of
    // actual session state, so the login screen never really gated
    // anything. /api/me is requireAuth-protected (401 when logged out).
    apiFetch('/api/me')
      .then((r) => setAuthed(r.ok))
      .catch(() => setAuthed(false));
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await apiFetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) {
      setAuthed(true);
      return null;
    }
    const err = await res.json();
    return err.error || 'Login failed';
  }, []);

  // 2026-07-16: self-serve signup — POST /api/signup creates the account
  // AND logs it straight in (same session cookie /api/login sets), so this
  // just needs to flip `authed` on success like login does.
  //
  // 2026-07-25: when the visitor arrives from the marketing site's voice
  // demo (?claim=demo-<uuid>), sign-up goes to /api/demo/claim instead,
  // which attaches the credentials to the demo's EXISTING users row rather
  // than inserting a new one — that's what keeps the vocabulary and
  // session history they just built in the demo. Same session cookie, so
  // success still just flips `authed`.
  const signup = useCallback(async (username: string, email: string, password: string) => {
    const claimId = pendingClaimId();
    const res = claimId
      ? await apiFetch('/api/demo/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ demoUserId: claimId, username, email, password }),
        })
      : await apiFetch('/api/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, email, password }),
        });
    if (res.ok) {
      // Drop the claim param so a refresh can't re-attempt a claim that
      // has already succeeded (it would 409 and read as a broken signup).
      if (claimId) clearClaimParam();
      setAuthed(true);
      return null;
    }
    const err = await res.json();
    return err.error || 'Sign up failed';
  }, []);

  const logout = useCallback(async () => {
    await apiFetch('/api/logout', { method: 'POST' });
    setAuthed(false);
  }, []);

  return { authed, login, signup, logout };
}

function LoginScreen({
  onLogin,
  onSwitchToSignup,
}: {
  onLogin: (username: string, password: string) => Promise<string | null>;
  onSwitchToSignup: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    const formData = new FormData(e.currentTarget);
    const username = String(formData.get('username') || '').trim();
    const password = String(formData.get('password') || '');
    const error = await onLogin(username, password);
    setSubmitting(false);
    if (error) setErr(error);
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <Typography.Heading level={1}>LingLang</Typography.Heading>
        <Typography.Paragraph style={{ color: "var(--muted)" }}>Sign in to continue</Typography.Paragraph>

        <form onSubmit={submit} className="flex flex-col gap-4 mt-4">
          <TextField isRequired name="username" autoFocus>
            <Label>Username</Label>
            <Input placeholder="Enter your username" autoCapitalize="off" autoCorrect="off" />
            <FieldError />
          </TextField>

          <TextField isRequired name="password" type="password">
            <Label>Password</Label>
            <Input placeholder="••••••••" />
            <FieldError />
          </TextField>

          {err && <div className="login-err">{err}</div>}

          <Button type="submit" variant="primary" isPending={submitting} fullWidth>
            {submitting ? 'Signing in…' : 'Enter'}
          </Button>
          <Button type="button" variant="ghost" onPress={onSwitchToSignup} fullWidth>
            Create an account
          </Button>
        </form>
      </div>
    </div>
  );
}

function SignupScreen({
  onSignup,
  onSwitchToLogin,
  claiming = false,
}: {
  onSignup: (username: string, email: string, password: string) => Promise<string | null>;
  onSwitchToLogin: () => void;
  claiming?: boolean;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErr(null);
    const formData = new FormData(e.currentTarget);
    const username = String(formData.get('username') || '').trim();
    const email = String(formData.get('email') || '').trim();
    const password = String(formData.get('password') || '');
    const confirmPassword = String(formData.get('confirmPassword') || '');
    if (password !== confirmPassword) {
      setErr('Passwords do not match');
      return;
    }
    setSubmitting(true);
    const error = await onSignup(username, email, password);
    setSubmitting(false);
    if (error) setErr(error);
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <Typography.Heading level={1}>LingLang</Typography.Heading>
        <Typography.Paragraph style={{ color: "var(--muted)" }}>
          {claiming
            ? 'Create your account to keep the conversation and vocabulary from your demo.'
            : 'Create your account'}
        </Typography.Paragraph>

        <form onSubmit={submit} className="flex flex-col gap-4 mt-4">
          <TextField isRequired name="username" autoFocus>
            <Label>Username</Label>
            <Input placeholder="Pick a username" autoCapitalize="off" autoCorrect="off" />
            <FieldError />
          </TextField>

          <TextField
            isRequired
            name="email"
            type="email"
            validate={(value) => {
              if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Enter a valid email address';
              return null;
            }}
          >
            <Label>Email</Label>
            <Input placeholder="you@example.com" autoCapitalize="off" autoCorrect="off" />
            <FieldError />
          </TextField>

          <TextField
            isRequired
            name="password"
            type="password"
            minLength={4}
            validate={(value) => {
              if (value.length < 4) return 'Password must be at least 4 characters';
              return null;
            }}
          >
            <Label>Password</Label>
            <Input placeholder="At least 4 characters" />
            <FieldError />
          </TextField>

          <TextField isRequired name="confirmPassword" type="password">
            <Label>Confirm password</Label>
            <Input placeholder="Repeat your password" />
            <FieldError />
          </TextField>

          {err && <div className="login-err">{err}</div>}

          <Button type="submit" variant="primary" isPending={submitting} fullWidth>
            {submitting ? 'Creating account…' : 'Create account'}
          </Button>
          <Button type="button" variant="ghost" onPress={onSwitchToLogin} fullWidth>
            Already have an account? Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const { authed, login, signup, logout } = useAuth();
  // Arriving from the demo means they've already decided to sign up —
  // landing them on the login form would be a dead end.
  const [claiming] = useState(() => pendingClaimId() !== null);
  const [screen, setScreen] = useState<'login' | 'signup'>(claiming ? 'signup' : 'login');

  if (authed === null) {
    return <div className="loading-wrap">Loading…</div>;
  }

  if (!authed) {
    return screen === 'login' ? (
      <LoginScreen onLogin={login} onSwitchToSignup={() => setScreen('signup')} />
    ) : (
      <SignupScreen onSignup={signup} onSwitchToLogin={() => setScreen('login')} claiming={claiming} />
    );
  }

  return <AppShell onLogout={logout} />;
}

// ─── Inline import to avoid circular deps ───
import AppShell from './components/AppShell';
