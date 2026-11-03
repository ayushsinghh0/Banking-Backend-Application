import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/App';
import { applyTheme } from '@/lib/theme';
import '@/styles/index.css';

// Apply the saved theme before the first paint (no inline script: the CSP forbids them)
applyTheme();

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
