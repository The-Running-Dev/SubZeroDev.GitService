import { useState } from 'react';
import { api, type EnrolResult } from './api.ts';

interface Props {
  readonly onEnrolled: () => void;
}

/**
 * S18.12. Demands the provisioning secret rather than treating the file's
 * presence as authorisation — the secret field is a real, required input,
 * never inferred. The ten recovery codes are shown exactly once, from this
 * response alone; nothing re-fetches or re-displays them afterwards.
 */
export function Enrol({ onEnrolled }: Props) {
  const [provisioningSecret, setProvisioningSecret] = useState('');
  const [subject, setSubject] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EnrolResult | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await api.post<EnrolResult | { readonly error: string }>('/auth/enrol', {
      provisioningSecret,
      subject,
      password,
    });
    if (!res.ok) {
      setError('error' in res.body ? res.body.error : 'enrolment failed');
      return;
    }
    setResult(res.body as EnrolResult);
  }

  if (result) {
    return (
      <main>
        <h1>Recovery codes</h1>
        <p>These ten codes are shown once. Store them somewhere safe — each works exactly once.</p>
        <ul data-testid="recovery-codes">
          {result.recoveryCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <p>TOTP secret (add to an authenticator app): <code>{result.totpSecret}</code></p>
        <button type="button" onClick={onEnrolled}>
          Continue to sign in
        </button>
      </main>
    );
  }

  return (
    <main>
      <h1>First-time setup</h1>
      <p>Enter the provisioning secret written to the volume at first boot.</p>
      <form onSubmit={submit}>
        <label>
          Provisioning secret
          <input
            type="password"
            value={provisioningSecret}
            onChange={(e) => setProvisioningSecret(e.target.value)}
            data-testid="provisioning-secret"
          />
        </label>
        <label>
          Operator subject
          <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} data-testid="enrol-subject" />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="enrol-password" />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit">Enrol</button>
      </form>
    </main>
  );
}
