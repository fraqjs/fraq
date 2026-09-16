import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import { App } from './app';
import { base } from './client';
import './style.css';

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter basename={base}>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
