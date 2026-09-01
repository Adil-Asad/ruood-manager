import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './theme/manager.css';
import './theme/ruood.css';
import { App } from './app';

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
