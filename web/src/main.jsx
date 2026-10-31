import { StrictMode, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createAuthClient } from './auth-client.js';
import { App, StartupError, useTheme } from './App.jsx';
import { DialogProvider } from './dialogs.jsx';
import { WalletProvider } from './wallet.jsx';
import './styles.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787';

function Root({ api, initialUser }) {
  const [theme, toggleTheme] = useTheme();
  const [toasts, setToasts] = useState([]);
  const toast = useCallback((message, tone = 'neutral', timeout = 4500) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((list) => [...list, { id, message, tone }]);
    setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), timeout);
  }, []);
  return (
    <WalletProvider appName={api.config.network?.appName || 'Router 3'} dark={theme === 'dark'}>
      <DialogProvider>
        <App api={api} apiBaseUrl={API_BASE_URL} theme={theme} onToggleTheme={toggleTheme} initialUser={initialUser} toast={toast} />
      </DialogProvider>
      <div className="toasts" aria-live="polite">
        {toasts.map((item) => <div key={item.id} className="toast" data-tone={item.tone} role="status">{item.message}</div>)}
      </div>
    </WalletProvider>
  );
}

const root = createRoot(document.querySelector('#app'));
(async () => {
  const api = await createAuthClient(API_BASE_URL);
  const user = await api.getMe().catch(() => null);
  root.render(<StrictMode><Root api={api} initialUser={user} /></StrictMode>);
})().catch((error) => root.render(<StartupError error={error} />));
