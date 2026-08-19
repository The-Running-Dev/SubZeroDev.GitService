import { Fragment, useEffect, useState } from 'react';
import { api, auditQueryPath, type AuditFilter, type AuditPageDto, type AuditRecordDto } from './api.ts';

interface Props {
  readonly onSignedOut: () => void;
  readonly onBack: () => void;
}

const EMPTY_FILTER: AuditFilter = { declarationId: '', tool: '', actorSubject: '', form: '', from: '', to: '' };

const RECORD_FORMS = ['call', 'authorization-rejection', 'hatch-intent', 'hatch-outcome', 'file-watcher', 'identity-event', 'lease-takeover'];

function ChainSummary({ chain }: { readonly chain: AuditPageDto['chain'] }) {
  return (
    <section>
      <h2>Chain state</h2>
      <dl>
        <dt>Verified through</dt>
        <dd data-testid="chain-verified-through">{chain.verifiedThrough ?? 'unverified'}</dd>
        <dt>Retained anchors</dt>
        <dd data-testid="chain-anchor-count">{chain.retainedAnchors.length}</dd>
      </dl>
      {chain.retainedAnchors.length > 0 && (
        <table data-testid="chain-anchor-list">
          <thead>
            <tr>
              <th>Segment</th>
              <th>Terminal sequence</th>
              <th>Retained at</th>
            </tr>
          </thead>
          <tbody>
            {chain.retainedAnchors.map((anchor) => (
              <tr key={anchor.segment} data-testid={`anchor-row-${anchor.segment}`}>
                <td>{anchor.segment}</td>
                <td>{anchor.terminalSequence}</td>
                <td>{anchor.retainedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {chain.chainBreak && (
        <p role="alert" data-testid="chain-break-banner">
          Chain break at sequence {chain.chainBreak.atSequence}: expected {chain.chainBreak.expectedHash}, found {chain.chainBreak.foundHash ?? 'nothing'}.
        </p>
      )}
    </section>
  );
}

function RecordRow({ record }: { readonly record: AuditRecordDto }) {
  return (
    <tr data-testid={`audit-record-row-${record.sequence}`}>
      <td>{record.sequence}</td>
      <td>{record.at}</td>
      <td>{record.form}</td>
      <td>{record.declarationId ?? '—'}</td>
      <td>{record.tool ?? '—'}</td>
      <td>{record.actorRef.subject}</td>
    </tr>
  );
}

/**
 * S33 — the audit trail read from the console, narrowed by declaration, tool,
 * actor and time window, with chain integrity shown alongside the records
 * rather than as a separate view. `chain.chainBreak`, when present, is
 * rendered as a marker row at the sequence it names — the records either
 * side of it still render, matching S33.4's "does not fail closed".
 */
export function Audit({ onSignedOut, onBack }: Props) {
  const [filter, setFilter] = useState<AuditFilter>(EMPTY_FILTER);
  const [page, setPage] = useState<AuditPageDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(next: AuditFilter): Promise<void> {
    setError(null);
    const res = await api.get<AuditPageDto>(auditQueryPath(next, null));
    if (!res.ok) {
      if (res.status === 401) {
        onSignedOut();
        return;
      }
      setError('could not load the audit trail');
      return;
    }
    setPage(res.body);
  }

  function updateFilter(patch: Partial<AuditFilter>): void {
    setFilter({ ...filter, ...patch });
  }

  useEffect(() => {
    void load(EMPTY_FILTER);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const records = page ? [...page.records].sort((a, b) => a.sequence - b.sequence) : [];
  const chainBreak = page?.chain.chainBreak ?? null;
  let breakRendered = false;

  return (
    <main>
      <button type="button" data-testid="audit-back" onClick={onBack}>
        Back
      </button>
      <h1>Audit trail</h1>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void load(filter);
        }}
      >
        <label>
          Repository
          <input data-testid="audit-filter-declaration" value={filter.declarationId} onChange={(event) => updateFilter({ declarationId: event.target.value })} />
        </label>
        <label>
          Tool
          <input data-testid="audit-filter-tool" value={filter.tool} onChange={(event) => updateFilter({ tool: event.target.value })} />
        </label>
        <label>
          Actor
          <input data-testid="audit-filter-actor" value={filter.actorSubject} onChange={(event) => updateFilter({ actorSubject: event.target.value })} />
        </label>
        <label>
          Form
          <select data-testid="audit-filter-form" value={filter.form} onChange={(event) => updateFilter({ form: event.target.value })}>
            <option value="">any</option>
            {RECORD_FORMS.map((form) => (
              <option key={form} value={form}>
                {form}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input data-testid="audit-filter-from" type="datetime-local" value={filter.from} onChange={(event) => updateFilter({ from: event.target.value ? new Date(event.target.value).toISOString() : '' })} />
        </label>
        <label>
          To
          <input data-testid="audit-filter-to" type="datetime-local" value={filter.to} onChange={(event) => updateFilter({ to: event.target.value ? new Date(event.target.value).toISOString() : '' })} />
        </label>
        <button type="submit" data-testid="audit-search">
          Search
        </button>
      </form>

      {error && <p role="alert">{error}</p>}
      {page && <ChainSummary chain={page.chain} />}

      {page && (
        <table data-testid="audit-record-list">
          <thead>
            <tr>
              <th>Sequence</th>
              <th>At</th>
              <th>Form</th>
              <th>Repository</th>
              <th>Tool</th>
              <th>Actor</th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 && (
              <tr>
                <td colSpan={6} data-testid="audit-record-list-empty">
                  No records match this filter.
                </td>
              </tr>
            )}
            {records.map((record) => {
              const renderBreakHere = chainBreak !== null && !breakRendered && record.sequence >= chainBreak.atSequence;
              if (renderBreakHere) breakRendered = true;
              return (
                <Fragment key={record.sequence}>
                  {renderBreakHere && (
                    <tr data-testid="audit-record-list-break">
                      <td colSpan={6}>Chain break at sequence {chainBreak!.atSequence}</td>
                    </tr>
                  )}
                  <RecordRow record={record} />
                </Fragment>
              );
            })}
            {chainBreak && !breakRendered && (
              <tr data-testid="audit-record-list-break">
                <td colSpan={6}>Chain break at sequence {chainBreak.atSequence}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </main>
  );
}
