import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/global.css';
import App from './App.tsx';
import { report } from './lib/report';
import { forgiveMovedNodes } from './lib/translators';
import { reloadOnStaleBuild } from './lib/stale-build';
import { startPicking } from './lib/api';

reloadOnStaleBuild();
// A page translator moving a node React made never blanks the app (lib/translators.ts).
forgiveMovedNodes(Node.prototype, report);
// The server nearest this reader, timed now and every few minutes (lib/servers.ts).
startPicking();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The app kept in this browser, to open with no connection (public/sw.js). Not while developing,
// where a kept page would hide each change.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
