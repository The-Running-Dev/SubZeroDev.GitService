import type { ConsoleViewProps, ConsoleViewRegistration } from '@subzerodev-git/console';

/**
 * The example consumer's one registered view (S35.6), reusing the base's
 * published `ConsoleViewRegistration` shape unmodified. It never names the
 * declaration it belongs to (`20-contract.md` § *Console view
 * registration*) — it receives `declarationId` as a prop, the same as every
 * other view.
 */
function ExampleNoteView({ declarationId }: ConsoleViewProps) {
  return (
    <section>
      <h1>Example note</h1>
      <p>Registered by the example consumer for declaration {declarationId}.</p>
    </section>
  );
}

export const EXAMPLE_VIEWS: readonly ConsoleViewRegistration[] = [
  {
    id: 'example-note',
    title: 'Example note',
    capabilities: ['content.exampleNote.read'],
    render: (props) => <ExampleNoteView {...props} />,
  },
];
