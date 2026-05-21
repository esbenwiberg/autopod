import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { readTokenFromHash } from './lib/token.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root element missing from index.html');

readTokenFromHash();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
