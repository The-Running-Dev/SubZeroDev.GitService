import { useEffect, useState } from 'react';
import { api, type TotpReenrolStart } from './api.ts';

interface Props {
  readonly onCompleted: () => void;
}

/**
 * S31.4/S31.5. Reached whenever the current session carries
 * `totpReenrolRequired` (`App.tsx`) — after a recovery-code sign-in forced
 * the lockout (S4.4). `beginTotpReenrol` runs once on mount; the old
 * authenticator keeps working until a correct code against the freshly
 * shown secret is confirmed, so a reload mid-flow costs a fresh secret, not
 * a lockout.
 */
export function TotpReenrol({ onCompleted }: Props) {
  const [totpSecret, setTotpSecret] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.post<TotpReenrolStart | { readonly error: string }>('/auth/totp-reenrol/begin').then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setError('error' in res.body ? res.body.error : 'could not start re-enrolment');
        return;
      }
      setTotpSecret((res.body as TotpReenrolStart).totpSecret);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await api.post<{ readonly reenrolled: true } | { readonly error: string }>('/auth/totp-reenrol/complete', {
      totpCode: code,
    });
    if (!res.ok) {
      setError('error' in res.body ? res.body.error : 'the code did not verify');
      return;
    }
    onCompleted();
  }

  return (
    <main>
      <h1>Re-enrol your authenticator</h1>
      <p>You signed in with a recovery code. Add a fresh authenticator before continuing.</p>
      {totpSecret === null && !error && <p>Loading…</p>}
      {totpSecret && (
        <form onSubmit={submit}>
          <p>
            New TOTP secret (add to an authenticator app): <code data-testid="reenrol-secret">{totpSecret}</code>
          </p>
          <label>
            TOTP code
            <input type="text" value={code} onChange={(e) => setCode(e.target.value)} data-testid="reenrol-totp" />
          </label>
          {error && <p role="alert">{error}</p>}
          <button type="submit">Confirm</button>
        </form>
      )}
    </main>
  );
}
