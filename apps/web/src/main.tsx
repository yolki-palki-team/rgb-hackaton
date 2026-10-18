import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { DEMO_URL } from './links';
import './styles.css';
import './tailwind.css';

if (window.location.pathname.replace(/\/$/, '') === '/demo') {
  window.location.replace(DEMO_URL);
} else {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
