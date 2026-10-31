import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppContext } from './context.js';
import { useDialogs } from './dialogs.jsx';
import { useWallet } from './wallet.jsx';
import { Banner, Button, Icon } from './ui.jsx';
import { shortAddress } from './format.js';
import { gatewayBaseUrl } from './snippets.js';
import { Channels } from './views/Channels.jsx';
import { Keys } from './views/Keys.jsx';
import { Models } from './views/Models.jsx';
import { Quickstart } from './views/Quickstart.jsx';
import { FlowDiagram } from './FlowDiagram.jsx';
import { NETWORK } from './chain.js';
import { lang, setLang, t } from './i18n.js';

const VIEWS = [
  { id: 'keys', label: t('API keys'), icon: 'key', group: t('Account'), Component: Keys },
  { id: 'models', label: t('Models'), icon: 'cube', group: t('Account'), Component: Models },
  { id: 'quickstart', label: t('Quickstart'), icon: 'book', group: t('Help'), Component: Quickstart },
  { id: 'channels', label: 'Self-signed channels', icon: 'zap', group: t('Advanced'), Component: Channels }
];
// Old bookmarks keep working after the navigation was renamed.
const ALIASES = { dashboard: 'keys', overview: 'keys', wallet: 'keys', funding: 'keys', activity: 'keys', projects: 'keys' };

function viewFromHash() {
  const raw = location.hash.replace(/^#\/?/, '').split('?')[0];
  const id = ALIASES[raw] ?? raw;
  if (id === 'home') return 'home';
  return VIEWS.some((view) => view.id === id) ? id : 'keys';
}

function useHashView() {
  const [viewId, setViewId] = useState(viewFromHash);
  useEffect(() => {
    const onChange = () => setViewId(viewFromHash());
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return viewId;
}

const navigate = (id) => { location.hash = `#/${id}`; };

export function BrandMark({ size = 26 }) {
  return (
    <svg className="brand-mark" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <g fill="none" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round">
        <path stroke="currentColor" d="M11 18 23 32 11 46M26 18 38 32 26 46" />
        <path stroke="var(--accent)" d="M41 18 53 32 41 46" />
      </g>
    </svg>
  );
}

function Brand({ name }) {
  const [, word, digit] = name.match(/^(.*\s)(\d+)$/) ?? [null, name, ''];
  return (
    <a className="brand" href="#/home" aria-label={name}>
      <BrandMark />
      <span>{word}{digit && <span className="brand-digit">{digit}</span>}</span>
      <span className="demo-pill" title={t('Demo: the service may change or stop')}>Demo</span>
    </a>
  );
}

function ThemeButton({ theme, onToggle, withLabel }) {
  const dark = theme === 'dark';
  return (
    <button className="ghost" type="button" aria-label={t('Toggle dark mode')} onClick={onToggle}>
      <Icon name={dark ? 'sun' : 'moon'} />{withLabel ? (dark ? t('Light') : t('Dark')) : null}
    </button>
  );
}

// Each language is named in itself.
function LangSelect() {
  return (
    <label className="lang-select">
      <Icon name="globe" />
      <select aria-label="Language / 语言" value={lang} onChange={event => setLang(event.target.value)}>
        <option value="en">English</option>
        <option value="zh">中文</option>
      </select>
    </label>
  );
}

function GitHubLink({ className = 'ghost' }) {
  return (
    <a className={`github-link ${className}`} href="https://github.com/scottham/router3-public"
      target="_blank" rel="noopener noreferrer" aria-label="GitHub">
      <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.65 7.65 0 0 1 8 3.86c.68 0 1.36.09 2 .26 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
      <span>GitHub</span>
    </a>
  );
}

function Landing({ api, appName, network, theme, onToggleTheme, onSignedIn, signedIn }) {
  const wallet = useWallet();
  const [status, setStatus] = useState({ text: '', tone: 'neutral' });
  const [busy, setBusy] = useState(false);
  async function signIn() {
    setBusy(true);
    setStatus({ text: t('Choose a wallet in the dialog…'), tone: 'neutral' });
    try {
      const provider = await wallet.requestProvider({ fresh: true });
      setStatus({ text: t('Sign the sign-in message in your wallet…'), tone: 'neutral' });
      onSignedIn(await api.signIn(provider));
      if (viewFromHash() === 'home') navigate('keys');
    } catch (error) {
      setStatus({ text: error.message, tone: 'danger' });
      setBusy(false);
    }
  }
  const enter = () => (signedIn ? navigate('keys') : signIn());
  useEffect(() => { document.title = appName; }, [appName]);
  return (
    <div className="landing">
      <nav className="landing-nav">
        <Brand name={appName} />
        <span className="spacer" />
        <GitHubLink className="btn secondary" />
        <span className="network-pill"><span aria-hidden="true" />{network}</span>
        <LangSelect />
        <ThemeButton theme={theme} onToggle={onToggleTheme} />
        <Button onClick={enter} disabled={busy}>{t('Console')}</Button>
      </nav>
      <main className="landing-main" id="main">
        <section className="hero">
          <p className="eyebrow">Your route, your money</p>
          <h1>{t('Model APIs, ')}<span className="hero-accent">{t('paid automatically from your own wallet')}</span></h1>
          <p className="lede">{t('Connect a wallet, turn on automatic payment with one signature, create API keys. Call them like OpenAI and pay for the tokens you use. A small pool refills from your wallet as needed; it stays yours and can only pay for usage or go back to you.')}</p>
          <div className="hero-actions">
            <Button variant="primary" size="lg" onClick={enter} disabled={busy}>{signedIn ? t('Open console') : t('Connect wallet')}</Button>
            <span className="status-line" role="status" data-tone={status.tone}>{status.text}</span>
          </div>
        </section>
        <FlowDiagram />
        <dl className="specs">
          {[[t('API'), t('/v1/chat/completions · /v1/messages · /v1/responses · streaming')],
            [t('Payment'), t('API keys · prepaid pool refilled from your wallet · zero gas · 128 concurrent by default')],
            [t('Settlement'), t('batched debits with refills → sweep → Treasury · daily limit on-chain · withdraw any time')],
            [t('Pricing'), t('Provider price + service fee · hold first, charge actual usage')]
          ].map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}
        </dl>
      </main>
      <footer className="landing-foot">
        <span>{appName} · {network}</span>
        <span>{t('Demo · the service may change or stop; keep the allowance small.')}</span>
      </footer>
    </div>
  );
}

function Shell({ app, viewId, theme, onToggleTheme, onSignOut }) {
  const [navOpen, setNavOpen] = useState(false);
  const view = VIEWS.find((item) => item.id === viewId);
  const sidebar = useRef(null);
  const wallet = app.wallet();
  useEffect(() => { document.title = `${view.label} · ${app.appName}`; window.scrollTo(0, 0); setNavOpen(false); }, [viewId]);
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') setNavOpen(false);
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < VIEWS.length) { event.preventDefault(); navigate(VIEWS[index].id); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  const groups = [...new Set(VIEWS.map((item) => item.group))];
  return (
    <div className="shell" data-nav-open={navOpen ? '' : undefined}
      onClick={(event) => { if (navOpen && !sidebar.current.contains(event.target) && !event.target.closest('.mobile-bar')) setNavOpen(false); }}>
      <aside className="sidebar" ref={sidebar}>
        <Brand name={app.appName} />
        <nav aria-label={t('Console navigation')}>
          {groups.map((group) => (
            <div className="nav-group" key={group}>
              <p className="nav-title">{group}</p>
              {VIEWS.filter((item) => item.group === group).map((item) => (
                <a key={item.id} className="nav-item" href={`#/${item.id}`} aria-current={item.id === viewId ? 'page' : undefined}
                  onClick={() => setNavOpen(false)}><Icon name={item.icon} /><span>{item.label}</span></a>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <GitHubLink />
          <div className="account">
            <span className="account-avatar" aria-hidden="true" />
            <div><code title={wallet?.address ?? ''}>{shortAddress(wallet?.address, 6, 4)}</code><small>{app.network}</small></div>
          </div>
          <div className="sidebar-actions">
            <LangSelect />
            <ThemeButton theme={theme} onToggle={onToggleTheme} withLabel />
            <button className="ghost" type="button" onClick={onSignOut}><Icon name="logout" />{t('Sign out')}</button>
          </div>
        </div>
      </aside>
      <div className="content">
        <div className="mobile-bar">
          <button className="ghost" type="button" aria-label={t('Open navigation')} onClick={() => setNavOpen(true)}><Icon name="menu" /></button>
          <Brand name={app.appName} />
          <span className="spacer" />
          <GitHubLink />
        </div>
        <main className="page" id="main" tabIndex={-1}>
          <view.Component key={`${viewId}:${app.revision}`} />
        </main>
      </div>
    </div>
  );
}

const THEME_KEY = 'router3:theme';
const systemTheme = () => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

export function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? systemTheme());
  const toggle = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* preference is optional */ }
    setTheme(next);
  }, [theme]);
  return [theme, toggle];
}

export function App({ api, apiBaseUrl, theme, onToggleTheme, initialUser, toast }) {
  const dialogs = useDialogs();
  const wallet = useWallet();
  const viewId = useHashView();
  const [user, setUser] = useState(initialUser);
  const [revision, setRevision] = useState(0);
  const models = useRef(null);
  const appName = api.config.network?.appName || 'Router 3';
  const network = NETWORK.name;

  const reset = useCallback(() => { models.current = null; setUser(null); }, []);
  const signOut = useCallback(async () => {
    try { await api.signOut(); } catch (error) { toast(error.message, 'danger'); }
    await wallet.disconnect();
    reset();
  }, [api, wallet]);

  const context = useMemo(() => ({
    api, apiBaseUrl, appName, network, toast, navigate, dialogs, user, revision,
    gatewayUrl: gatewayBaseUrl(apiBaseUrl),
    // The wallet the user signed in with is the payer whose channels are shown.
    wallet() {
      const connected = user?.connectedWallet;
      const wallets = user?.wallets ?? [];
      return wallets.find((item) => connected && item.address.toLowerCase() === connected.address.toLowerCase()
        && Number(item.chain_id) === Number(connected.chainId)) ?? wallets[0] ?? { address: connected?.address, chain_id: connected?.chainId };
    },
    async ensureModels() {
      models.current ??= api.listModels().catch((error) => { models.current = null; throw error; });
      return models.current;
    },
    async reload() { setRevision((value) => value + 1); },
    expire() { toast(t('Session expired; sign in again'), 'warning'); signOut(); }
  }), [api, apiBaseUrl, user, revision, signOut]);

  if (!user || viewId === 'home') {
    return <Landing api={api} appName={appName} network={network} theme={theme} onToggleTheme={onToggleTheme}
      signedIn={Boolean(user)} onSignedIn={setUser} />;
  }
  return (
    <AppContext.Provider value={context}>
      <Shell app={context} viewId={viewId} theme={theme} onToggleTheme={onToggleTheme} onSignOut={signOut} />
    </AppContext.Provider>
  );
}

export function StartupError({ error, appName = 'Router 3' }) {
  return (
    <div className="landing">
      <nav className="landing-nav"><Brand name={appName} /></nav>
      <main className="landing-main">
        <Banner title={t('Cannot reach the gateway API')} tone="danger">{t('{0}. Check that the API is running and VITE_API_BASE_URL matches CORS_ORIGINS.', error.message)}</Banner>
      </main>
    </div>
  );
}
