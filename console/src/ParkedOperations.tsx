import { useEffect, useState } from 'react';
import { api, loadResource, type ParkedOperationDto, type ParkedOperationsDto } from './api.ts';

interface Props {
  readonly onSignedOut: () => void;
  readonly onBack: () => void;
}

const COMPARED_FIELDS = ['branch', 'headSha', 'upstreamSha', 'indexDigest', 'worktreeDigest'] as const;

function DiffTable({ entry }: { readonly entry: ParkedOperationDto }) {
  if (entry.observed === null) {
    return (
      <p data-testid={`parked-unobservable-${entry.operationId}`}>
        The declaration's tree cannot be observed — this is the case a parked entry is most likely to be sitting on.
      </p>
    );
  }
  const movedFields = new Set((entry.diff ?? []).map((d) => d.field));
  return (
    <table data-testid={`parked-diff-${entry.operationId}`}>
      <thead>
        <tr>
          <th>Field</th>
          <th>Recorded</th>
          <th>Observed</th>
          <th>Moved</th>
        </tr>
      </thead>
      <tbody>
        {COMPARED_FIELDS.map((field) => (
          <tr key={field} data-testid={`parked-diff-row-${entry.operationId}-${field}`}>
            <td>{field}</td>
            <td>{String(entry.preState[field] ?? '—')}</td>
            <td>{String(entry.observed![field] ?? '—')}</td>
            <td>{movedFields.has(field) ? 'yes' : 'no'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * S34 — every operation the service stopped and set aside for a human, with
 * what it expected to find (`preState`) and what it actually found
 * (`observed`), and which of the five compared fields moved
 * (`http-server.ts`'s `stateComparison`, already computed server-side —
 * S34.4's own work is rendering it as a difference rather than two digest
 * strings). A tree that cannot be observed at all renders as unobservable
 * with the entry still listed (S34.5) rather than failing the view.
 */
export function ParkedOperations({ onSignedOut, onBack }: Props) {
  const [view, setView] = useState<ParkedOperationsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  function load(cancelledRef: { readonly current: boolean } = { current: false }): Promise<void> {
    return loadResource<ParkedOperationsDto>('/parked-operations', cancelledRef, {
      onSuccess: setView,
      onError: (status) => (status === 401 ? onSignedOut() : setError('could not load parked operations')),
    });
  }

  useEffect(() => {
    const cancelledRef = { current: false };
    load(cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function settle(operationId: string): Promise<void> {
    setPending(operationId);
    try {
      const res = await api.post(`/parked-operations/${encodeURIComponent(operationId)}/resolve`);
      if (!res.ok) {
        if (res.status === 401) {
          onSignedOut();
          return;
        }
        setError('could not settle the parked operation');
        return;
      }
      await load();
    } finally {
      setPending(null);
    }
  }

  if (error) return <p role="alert">{error}</p>;
  if (view === null) return <p>Loading…</p>;

  return (
    <main>
      <button type="button" data-testid="parked-back" onClick={onBack}>
        Back
      </button>
      <h1>Parked operations</h1>

      {view.operations.length === 0 && <p data-testid="parked-list-empty">No parked operations.</p>}

      <ul data-testid="parked-list">
        {view.operations.map((entry) => (
          <li key={entry.operationId} data-testid={`parked-row-${entry.operationId}`}>
            <dl>
              <dt>Repository</dt>
              <dd>{entry.declarationId}</dd>
              <dt>Tool</dt>
              <dd>{entry.tool}</dd>
              <dt>Reason</dt>
              <dd>{entry.reason ?? '—'}</dd>
              <dt>Started</dt>
              <dd>{entry.startedAt}</dd>
            </dl>
            <DiffTable entry={entry} />
            <button
              type="button"
              data-testid={`settle-${entry.operationId}`}
              disabled={pending === entry.operationId}
              onClick={() => settle(entry.operationId)}
            >
              Settle
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
