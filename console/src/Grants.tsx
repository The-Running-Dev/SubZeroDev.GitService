import { useEffect, useState } from 'react';
import { ActionButton } from './ActionButton.tsx';
import { api, loadResource, type GrantsView, type OAuthClientRecord } from './api.ts';

interface Props {
  readonly onSignedOut: () => void;
  readonly onBack: () => void;
}

interface ClientRow {
  readonly client: OAuthClientRecord;
  readonly lastUsedAt: string | null;
}

/**
 * There is no `listClients` in the contract (`20-contract.md` § L3 —
 * authorization): every `OAuthClient` this view can see arrives embedded on
 * an `mcp` `GrantView`, so a client's row here — and the "last used" this
 * criterion asks for — is derived from its own grants rather than fetched
 * separately. `operator-api` grants never carry a client (S32 acceptance,
 * `20-contract.md` line 468).
 */
function deriveClients(view: GrantsView): readonly ClientRow[] {
  const byId = new Map<string, ClientRow>();
  for (const { grant, client } of view.grants) {
    if (!client) continue;
    const existing = byId.get(client.clientId);
    const lastUsedAt = existing?.lastUsedAt && (!grant.lastUsedAt || existing.lastUsedAt > grant.lastUsedAt) ? existing.lastUsedAt : grant.lastUsedAt;
    byId.set(client.clientId, { client, lastUsedAt });
  }
  return Array.from(byId.values());
}

/**
 * S32 — every credential this service has issued, on one screen: registered
 * clients, MCP grants, operator API tokens (an `operator-api` grant),
 * operator sessions and the live MCP sessions folded into each grant's
 * `liveSessions` count. Revoking any row calls S13/S14's existing cascade
 * (`authorization-routes.ts`) rather than a second implementation; this
 * component only renders and reloads.
 */
export function Grants({ onSignedOut, onBack }: Props) {
  const [view, setView] = useState<GrantsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  function load(cancelledRef: { readonly current: boolean } = { current: false }): Promise<void> {
    return loadResource<GrantsView>('/grants', cancelledRef, {
      onSuccess: setView,
      onError: (status) => (status === 401 ? onSignedOut() : setError('could not load grants')),
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

  async function revoke(key: string, path: string): Promise<void> {
    setPending(key);
    try {
      const res = await api.post(path);
      if (!res.ok) {
        if (res.status === 401) {
          onSignedOut();
          return;
        }
        setError('could not revoke');
        return;
      }
      await load();
    } catch {
      setError('could not revoke');
    } finally {
      setPending(null);
    }
  }

  if (error) return <p role="alert">{error}</p>;
  if (view === null) return <p>Loading…</p>;

  const clients = deriveClients(view);
  const mcpGrants = view.grants.filter((v) => v.grant.kind === 'mcp');
  const apiTokens = view.grants.filter((v) => v.grant.kind === 'operator-api');

  return (
    <main>
      <button type="button" data-testid="grants-back" onClick={onBack}>
        Back
      </button>
      <h1>Grants</h1>

      <section>
        <h2>Registered clients</h2>
        <table data-testid="client-list">
          <thead>
            <tr>
              <th>Client</th>
              <th>Registered</th>
              <th>Last used</th>
              <th>Revoked</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {clients.map(({ client, lastUsedAt }) => (
              <tr key={client.clientId} data-testid={`client-row-${client.clientId}`}>
                <td>{client.clientId}</td>
                <td>{client.registeredAt}</td>
                <td>{lastUsedAt ?? 'never'}</td>
                <td data-testid={`client-revoked-${client.clientId}`}>{client.revokedAt ?? 'no'}</td>
                <td>
                  <ActionButton
                    testId={`revoke-client-${client.clientId}`}
                    disabled={client.revokedAt !== null || pending === `client-${client.clientId}`}
                    label="Revoke"
                    onAction={() => revoke(`client-${client.clientId}`, `/clients/${encodeURIComponent(client.clientId)}/revoke`)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>MCP grants</h2>
        <table data-testid="mcp-grant-list">
          <thead>
            <tr>
              <th>Subject</th>
              <th>Repository</th>
              <th>Scopes</th>
              <th>Active tokens</th>
              <th>Live sessions (not tracked)</th>
              <th>Last used</th>
              <th>Revoked</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {mcpGrants.map(({ grant, activeTokens, liveSessions }) => (
              <tr key={grant.grantId} data-testid={`grant-row-${grant.grantId}`}>
                <td>{grant.subject}</td>
                <td>{grant.declarationId ?? '—'}</td>
                <td>{grant.scopes.join(', ')}</td>
                <td>{activeTokens}</td>
                <td>{liveSessions}</td>
                <td>{grant.lastUsedAt ?? 'never'}</td>
                <td>{grant.revokedAt ?? 'no'}</td>
                <td>
                  <ActionButton
                    testId={`revoke-grant-${grant.grantId}`}
                    disabled={grant.revokedAt !== null || pending === `grant-${grant.grantId}`}
                    label="Revoke"
                    onAction={() => revoke(`grant-${grant.grantId}`, `/grants/${encodeURIComponent(grant.grantId)}/revoke`)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Operator API tokens</h2>
        <table data-testid="operator-token-list">
          <thead>
            <tr>
              <th>Subject</th>
              <th>Scopes</th>
              <th>Active tokens</th>
              <th>Last used</th>
              <th>Revoked</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {apiTokens.map(({ grant, activeTokens }) => (
              <tr key={grant.grantId} data-testid={`grant-row-${grant.grantId}`}>
                <td>{grant.subject}</td>
                <td>{grant.scopes.join(', ')}</td>
                <td>{activeTokens}</td>
                <td>{grant.lastUsedAt ?? 'never'}</td>
                <td>{grant.revokedAt ?? 'no'}</td>
                <td>
                  <ActionButton
                    testId={`revoke-grant-${grant.grantId}`}
                    disabled={grant.revokedAt !== null || pending === `grant-${grant.grantId}`}
                    label="Revoke"
                    onAction={() => revoke(`grant-${grant.grantId}`, `/grants/${encodeURIComponent(grant.grantId)}/revoke`)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Operator sessions</h2>
        <table data-testid="operator-session-list">
          <thead>
            <tr>
              <th>Subject</th>
              <th>Created</th>
              <th>Last seen</th>
              <th>Revoked</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {view.operatorSessions.map((session) => (
              <tr key={session.ref} data-testid={`operator-session-row-${session.ref}`}>
                <td>{session.subject}</td>
                <td>{session.createdAt}</td>
                <td>{session.lastSeenAt}</td>
                <td>{session.revokedAt ?? 'no'}</td>
                <td>
                  <ActionButton
                    testId={`revoke-operator-session-${session.ref}`}
                    disabled={session.revokedAt !== null || pending === `session-${session.ref}`}
                    label="Revoke"
                    onAction={() => revoke(`session-${session.ref}`, `/operator-sessions/${encodeURIComponent(session.ref)}/revoke`)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
