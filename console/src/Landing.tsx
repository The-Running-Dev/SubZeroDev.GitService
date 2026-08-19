import { useEffect, useState } from 'react';
import { api, loadResource, type DeclarationListRow } from './api.ts';

const SELECTED_DECLARATION_KEY = 'szg-console-selected-declaration';

interface Props {
  readonly onSignedOut: () => void;
  readonly onNavigateGrants: () => void;
}

/**
 * S18.2. `GET /declarations` already carries clone state, current branch and
 * the dirty flag (`declaration-routes.ts`'s `landingViewFields`) and last
 * operation (`clone.lastOperationAt`). Selecting a row sets the repository
 * dimension for every later view; `localStorage` is what makes that survive
 * a reload rather than living only in this component's state.
 */
export function Landing({ onSignedOut, onNavigateGrants }: Props) {
  const [rows, setRows] = useState<readonly DeclarationListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem(SELECTED_DECLARATION_KEY));

  useEffect(() => {
    const cancelledRef = { current: false };
    loadResource<readonly DeclarationListRow[]>('/declarations', cancelledRef, {
      onSuccess: setRows,
      onError: () => setError('could not load declarations'),
    });
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  function select(id: string) {
    setSelected(id);
    localStorage.setItem(SELECTED_DECLARATION_KEY, id);
  }

  async function signOut() {
    await api.post('/auth/logout');
    onSignedOut();
  }

  if (error) return <p role="alert">{error}</p>;
  if (rows === null) return <p>Loading…</p>;

  return (
    <main>
      <h1>Repositories</h1>
      <button type="button" data-testid="nav-grants" onClick={onNavigateGrants}>
        Grants
      </button>
      <button type="button" data-testid="sign-out" onClick={signOut}>
        Sign out
      </button>
      <table data-testid="declaration-list">
        <thead>
          <tr>
            <th>Repository</th>
            <th>State</th>
            <th>Branch</th>
            <th>Dirty</th>
            <th>Last operation</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.declaration.id}
              data-testid={`declaration-row-${row.declaration.id}`}
              data-selected={selected === row.declaration.id}
              onClick={() => select(row.declaration.id)}
            >
              <td>{row.declaration.id}</td>
              <td>{row.clone?.state ?? 'absent'}</td>
              <td>{row.branch ?? '—'}</td>
              <td>{row.dirty ? 'yes' : 'no'}</td>
              <td>{row.clone?.lastOperationAt ?? 'never'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected && <p data-testid="selected-declaration">Selected: {selected}</p>}
    </main>
  );
}
