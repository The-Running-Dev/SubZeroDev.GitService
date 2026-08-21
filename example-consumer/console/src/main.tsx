import { createRoot } from 'react-dom/client';
import { createConsole } from '@subzerodev-git/console';
import { EXAMPLE_VIEWS } from './example-view.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('example-consumer console: no #root element in index.html');

createRoot(root).render(createConsole(EXAMPLE_VIEWS));
