import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/fonts.css';
import '../styles/tokens.css';
import '../styles/global.css';
import { report } from '../lib/report';
import { forgiveMovedNodes } from '../lib/translators';
import { AdminPage } from './Admin';

// A page translator moving a node React made never blanks the page (lib/translators.ts).
forgiveMovedNodes(Node.prototype, report);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AdminPage />
  </StrictMode>,
);
