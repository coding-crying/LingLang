import { useState, useEffect, useCallback } from 'react';

/** Check if we're authenticated by hitting a protected endpoint. */
function useAuth() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/stats')
      .then((r) => setAuthed(r.ok))
      .catch(() => setAuthed(false));
  }, []);

  const login = useCallback(async (password: string) => {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'will', password }),
    });
    if (res.ok) {
      setAuthed(true);
      return null;
    }
    const err = await res.json();
    return err.error || 'Login failed';
  }, []);

  const logout = useCallback(async () => {
    await fetch('/api/logout', { method: 'POST' });
    setAuthed(false);
  }, []);

  return { authed, login, logout };
}

function LoginScreen({ onLogin }: { onLogin: (pw: string) => Promise<string | null> }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    const error = await onLogin(pw);
    if (error) setErr(error);
  };

  return (
    <div className="login-wrap">
      <form onSubmit={submit} className="login-card">
        <h1>⚡ LingLang</h1>
        <input
          type="password"
          placeholder="Password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoFocus
        />
        {err && <div className="login-err">{err}</div>}
        <button type="submit" className="btn-primary">Enter</button>
      </form>
    </div>
  );
}

export default function App() {
  const { authed, login, logout } = useAuth();

  if (authed === null) {
    return <div className="loading-wrap">Loading…</div>;
  }

  if (!authed) {
    return <LoginScreen onLogin={login} />;
  }

  return <AppShell onLogout={logout} />;
}

// ─── Inline import to avoid circular deps ───
import AppShell from './components/AppShell';
