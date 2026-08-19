import { useState } from 'react';
import { api, type SessionEnvelope } from './api.ts';

interface Props {
  readonly onSignedIn: (session: SessionEnvelope) => void;
}

type Mode = 'password' | 'recovery-code' | 'break-glass';

/**
 * S18.10 — three sign-in paths, one per tab, each posting to its own
 * `/auth/login*` route. All three land on the same `SessionEnvelope` and the
 * same `onSignedIn` transition; the console never distinguishes how a
 * session was established once it exists.
 */
export function Login({ onSignedIn }: Props) {
  const [mode, setMode] = useState<Mode>('password');
  const [subject, setSubject] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [breakGlassToken, setBreakGlassToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await api.post<SessionEnvelope | { readonly error: string }>('/auth/login', { subject, password, totpCode });
    if (!res.ok) {
      setError('error' in res.body ? res.body.error : 'sign-in failed');
      return;
    }
    onSignedIn(res.body as SessionEnvelope);
  }

  async function submitRecoveryCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await api.post<SessionEnvelope | { readonly error: string }>('/auth/login/recovery-code', {
      subject,
      password,
      code: recoveryCode,
    });
    if (!res.ok) {
      setError('error' in res.body ? res.body.error : 'sign-in failed');
      return;
    }
    onSignedIn(res.body as SessionEnvelope);
  }

  async function submitBreakGlass(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await api.post<SessionEnvelope | { readonly error: string }>('/auth/login/break-glass', { token: breakGlassToken });
    if (!res.ok) {
      setError('error' in res.body ? res.body.error : 'sign-in failed');
      return;
    }
    onSignedIn(res.body as SessionEnvelope);
  }

  return (
    <main>
      <h1>Sign in</h1>
      <nav>
        <button type="button" data-testid="tab-password" aria-pressed={mode === 'password'} onClick={() => setMode('password')}>
          Password + TOTP
        </button>
        <button type="button" data-testid="tab-recovery-code" aria-pressed={mode === 'recovery-code'} onClick={() => setMode('recovery-code')}>
          Recovery code
        </button>
        <button type="button" data-testid="tab-break-glass" aria-pressed={mode === 'break-glass'} onClick={() => setMode('break-glass')}>
          Break-glass
        </button>
      </nav>

      {mode === 'password' && (
        <form onSubmit={submitPassword}>
          <label>
            Subject
            <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} data-testid="login-subject" />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="login-password" />
          </label>
          <label>
            TOTP code
            <input type="text" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} data-testid="login-totp" />
          </label>
          {error && <p role="alert">{error}</p>}
          <button type="submit">Sign in</button>
        </form>
      )}

      {mode === 'recovery-code' && (
        <form onSubmit={submitRecoveryCode}>
          <label>
            Subject
            <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} data-testid="recovery-subject" />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="recovery-password" />
          </label>
          <label>
            Recovery code
            <input type="text" value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} data-testid="recovery-code" />
          </label>
          {error && <p role="alert">{error}</p>}
          <button type="submit">Sign in with recovery code</button>
        </form>
      )}

      {mode === 'break-glass' && (
        <form onSubmit={submitBreakGlass}>
          <label>
            Break-glass token
            <input
              type="password"
              value={breakGlassToken}
              onChange={(e) => setBreakGlassToken(e.target.value)}
              data-testid="break-glass-token"
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <button type="submit">Sign in with break-glass token</button>
        </form>
      )}

      {/* S31.2 — a full-page navigation, not a fetch: the redirect to the issuer and back is the flow, not an API call this component makes. */}
      <p>
        <a href="/auth/login/oidc" data-testid="sso-link">
          Sign in with your identity provider
        </a>
      </p>
    </main>
  );
}
