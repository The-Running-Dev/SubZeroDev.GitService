import { useEffect, useState } from 'react';
import { api, type SessionEnvelope } from './api.ts';
import { Enrol } from './Enrol.tsx';
import { Login } from './Login.tsx';
import { Landing } from './Landing.tsx';
import { TotpReenrol } from './TotpReenrol.tsx';
import { Grants } from './Grants.tsx';
import { Audit } from './Audit.tsx';
import { Health } from './Health.tsx';
import { ParkedOperations } from './ParkedOperations.tsx';

type Screen = 'loading' | 'enrol' | 'login' | 'totp-reenrol' | 'landing' | 'grants' | 'audit' | 'health' | 'parked-operations';

/**
 * S18.12's "shows the enrolment screen and no other" without a new
 * unauthenticated field on `LivenessReport` (which S18.9 forbids widening to
 * carry operator state): `loginLocal` already answers `not-provisioned`
 * before it ever compares a password (`operator-identity.ts`) — no store
 * write, no audit line, no lockout counter on that branch. Probing it with
 * empty credentials on mount is a safe, side-effect-free read of exactly the
 * fact this screen needs, through the one route the contract already fixes
 * for it, rather than inventing a second one.
 */
async function resolveInitialScreen(): Promise<Screen> {
  const session = await api.get<SessionEnvelope>('/auth/session');
  if (session.ok) return session.body.totpReenrolRequired ? 'totp-reenrol' : 'landing';

  const probe = await api.post<{ readonly error: string }>('/auth/login', { subject: '', password: '', totpCode: '' });
  if (!probe.ok && probe.body.error === 'not-provisioned') return 'enrol';
  return 'login';
}

export function App() {
  const [screen, setScreen] = useState<Screen>('loading');

  useEffect(() => {
    let cancelled = false;
    resolveInitialScreen().then((next) => {
      if (!cancelled) setScreen(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (screen === 'loading') return <p>Loading…</p>;
  if (screen === 'enrol') return <Enrol onEnrolled={() => setScreen('login')} />;
  if (screen === 'login') {
    return <Login onSignedIn={(session) => setScreen(session.totpReenrolRequired ? 'totp-reenrol' : 'landing')} />;
  }
  if (screen === 'totp-reenrol') return <TotpReenrol onCompleted={() => setScreen('landing')} />;
  if (screen === 'grants') {
    return <Grants onSignedOut={() => setScreen('login')} onBack={() => setScreen('landing')} />;
  }
  if (screen === 'audit') {
    return <Audit onSignedOut={() => setScreen('login')} onBack={() => setScreen('landing')} />;
  }
  if (screen === 'health') {
    return <Health onSignedOut={() => setScreen('login')} onBack={() => setScreen('landing')} />;
  }
  if (screen === 'parked-operations') {
    return <ParkedOperations onSignedOut={() => setScreen('login')} onBack={() => setScreen('landing')} />;
  }
  return (
    <Landing
      onSignedOut={() => setScreen('login')}
      onNavigateGrants={() => setScreen('grants')}
      onNavigateAudit={() => setScreen('audit')}
      onNavigateHealth={() => setScreen('health')}
      onNavigateParkedOperations={() => setScreen('parked-operations')}
    />
  );
}
