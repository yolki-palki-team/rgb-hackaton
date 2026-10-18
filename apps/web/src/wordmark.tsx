import React from 'react';
import { createRoot } from 'react-dom/client';
import HalftoneWordmarkFooter from './components/ui/halftone-wordmark-footer';
import './wordmark.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HalftoneWordmarkFooter
      wordmark="pálka"
      label=""
      meta=""
      columns={[]}
      backToTop={false}
      palette={{ background: '#000000', ink: '#eeeeee', warm: '#aaaaaa' }}
      grain={0}
      centered
      height="100dvh"
      className="wordmark-only"
    />
  </React.StrictMode>,
);
