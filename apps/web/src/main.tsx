import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthProvider } from './auth/AuthContext';
import { RouteErrorBoundary } from './components/ErrorBoundary';
import { initI18n } from './i18n';
import { applyPrefs, readPrefs } from './lib/displayPrefs';
import './index.css';

applyPrefs(readPrefs());

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

void initI18n().then(() => {
  createRoot(rootEl).render(
    <StrictMode>
      <BrowserRouter>
        <AuthProvider>
          <RouteErrorBoundary>
            <App />
          </RouteErrorBoundary>
        </AuthProvider>
      </BrowserRouter>
    </StrictMode>,
  );
});
