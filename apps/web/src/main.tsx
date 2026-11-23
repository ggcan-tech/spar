import { Capacitor } from '@capacitor/core';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './mobile.css';

const root = document.getElementById('root');
if (!root) throw new Error('SPAR: #root not found');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Do not cache Vite's development server. Installation is available in production on HTTPS
// (or localhost); a failed registration must never prevent opening the game.
if (import.meta.env.PROD && !Capacitor.isNativePlatform() && 'serviceWorker' in navigator) {
  const register = () => { void navigator.serviceWorker.register('/sw.js').catch((error: unknown) => console.warn('[spar] Offline screen unavailable', error)); };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
