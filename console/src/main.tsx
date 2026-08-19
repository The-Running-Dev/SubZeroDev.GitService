import { createRoot } from 'react-dom/client';
import { createConsole } from './index.ts';

const root = document.getElementById('root');
if (!root) throw new Error('console: no #root element in index.html');

createRoot(root).render(createConsole());
