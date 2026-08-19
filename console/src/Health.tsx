import { useEffect, useState } from 'react';
import { ActionButton } from './ActionButton.tsx';
import { api, loadResource, type FailedOutboxDto, type HealthReportDto, type OutboxRowDto } from './api.ts';

interface Props {
  readonly onSignedOut: () => void;
  readonly onBack: () => void;
}

/**
 * S34 — the two states that otherwise only ever appear in logs: failed
 * notification-outbox rows and failing credential references, alongside the
 * volume breakdown, parked count and audit chain state `/health` already
 * carries. Rows are listed rather than counted (S34.1) — a count names no
 * row to act on — so this view fetches `/health` for the summary and
 * `/notifier/failed` for the rows themselves.
 */
export function Health({ onSignedOut, onBack }: Props) {
  const [health, setHealth] = useState<HealthReportDto | null>(null);
  const [outbox, setOutbox] = useState<FailedOutboxDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  function load(cancelledRef: { readonly current: boolean } = { current: false }): Promise<[void, void]> {
    return Promise.all([
      loadResource<HealthReportDto>('/health', cancelledRef, {
        onSuccess: setHealth,
        onError: (status) => (status === 401 ? onSignedOut() : setError('could not load health')),
      }),
      loadResource<FailedOutboxDto>('/notifier/failed', cancelledRef, {
        onSuccess: setOutbox,
        onError: (status) => (status === 401 ? onSignedOut() : setError('could not load the failed outbox')),
      }),
    ]);
  }

  useEffect(() => {
    const cancelledRef = { current: false };
    load(cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function clearCredential(ref: string, declarationId: string): Promise<void> {
    const key = `credential-${ref}-${declarationId}`;
    setPending(key);
    try {
      const res = await api.post(`/failing-credentials/${encodeURIComponent(ref)}/${encodeURIComponent(declarationId)}/clear`);
      if (!res.ok) {
        if (res.status === 401) {
          onSignedOut();
          return;
        }
        setError('could not clear the credential mark');
        return;
      }
      await load();
    } finally {
      setPending(null);
    }
  }

  async function clearOutboxRow(row: OutboxRowDto): Promise<void> {
    const key = `outbox-${row.id}`;
    setPending(key);
    try {
      const res = await api.post(`/notifier/failed/${encodeURIComponent(row.id)}/clear`);
      if (!res.ok) {
        if (res.status === 401) {
          onSignedOut();
          return;
        }
        setError('could not clear the outbox row');
        return;
      }
      await load();
    } finally {
      setPending(null);
    }
  }

  if (error) return <p role="alert">{error}</p>;
  if (health === null || outbox === null) return <p>Loading…</p>;

  return (
    <main>
      <button type="button" data-testid="health-back" onClick={onBack}>
        Back
      </button>
      <h1>Health</h1>

      <section>
        <h2>Summary</h2>
        <dl>
          <dt>Ready</dt>
          <dd data-testid="health-ready">{health.ready ? 'yes' : 'no'}</dd>
          <dt>Audit chain verified through</dt>
          <dd data-testid="health-chain-verified-through">{health.auditChain.verifiedThrough ?? 'unverified'}</dd>
          <dt>Parked operations</dt>
          <dd data-testid="health-parked-count">{health.parkedOperations}</dd>
          <dt>Failed outbox rows</dt>
          <dd data-testid="health-failed-outbox-count">{health.failedOutboxRows}</dd>
        </dl>
      </section>

      <section>
        <h2>Volume</h2>
        <dl>
          <dt>Used</dt>
          <dd data-testid="health-volume-used">
            {health.volume.usedBytes} / {health.volume.totalBytes} bytes ({health.volume.usedPercent}%)
          </dd>
        </dl>
        <table data-testid="health-volume-by-consumer">
          <thead>
            <tr>
              <th>Consumer</th>
              <th>Bytes</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(health.volume.byConsumer).map(([consumer, bytes]) => (
              <tr key={consumer} data-testid={`health-volume-consumer-${consumer}`}>
                <td>{consumer}</td>
                <td>{bytes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Failing credentials</h2>
        <table data-testid="failing-credential-list">
          <thead>
            <tr>
              <th>Reference</th>
              <th>Repository</th>
              <th>Reason</th>
              <th>Marked</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {health.failingCredentialRefs.length === 0 && (
              <tr>
                <td colSpan={5} data-testid="failing-credential-list-empty">
                  No failing credentials.
                </td>
              </tr>
            )}
            {health.failingCredentialRefs.map((mark) => (
              <tr key={`${mark.ref}-${mark.declarationId}`} data-testid={`failing-credential-row-${mark.ref}-${mark.declarationId}`}>
                <td>{mark.ref}</td>
                <td>{mark.declarationId}</td>
                <td>{mark.reason}</td>
                <td>{mark.markedAt}</td>
                <td>
                  <ActionButton
                    testId={`clear-credential-${mark.ref}-${mark.declarationId}`}
                    disabled={pending === `credential-${mark.ref}-${mark.declarationId}`}
                    label="Clear"
                    onAction={() => clearCredential(mark.ref, mark.declarationId)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Failed outbox rows</h2>
        <table data-testid="failed-outbox-list">
          <thead>
            <tr>
              <th>Row</th>
              <th>Repository</th>
              <th>Attempts</th>
              <th>Last error</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {outbox.rows.length === 0 && (
              <tr>
                <td colSpan={6} data-testid="failed-outbox-list-empty">
                  No failed outbox rows.
                </td>
              </tr>
            )}
            {outbox.rows.map((row) => (
              <tr key={row.id} data-testid={`failed-outbox-row-${row.id}`}>
                <td>{row.id}</td>
                <td>{row.declarationId ?? '—'}</td>
                <td>{row.attempts}</td>
                <td>{row.lastError ?? '—'}</td>
                <td>{row.createdAt}</td>
                <td>
                  <ActionButton testId={`clear-outbox-${row.id}`} disabled={pending === `outbox-${row.id}`} label="Clear" onAction={() => clearOutboxRow(row)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
