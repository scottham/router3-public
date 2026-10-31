import { useEffect, useRef, useState } from 'react';
import { PROVIDER_COLORS } from './logic.js';
import { t } from './i18n.js';

// Stroke icons (24px grid, Lucide-style geometry), drawn from fixed path data.
const ICONS = {
  home: ['M3 10.5 12 3l9 7.5', 'M5 9.5V21h14V9.5', 'M9.5 21v-6h5v6'],
  activity: ['M3 12h4l3-8 4 16 3-8h4'],
  key: ['M14.5 9.5a4.5 4.5 0 1 1-1.3-3.2 4.5 4.5 0 0 1 1.3 3.2Z', 'm13.2 12.8 7.3 7.2', 'm17.5 17 2-2', 'm15.5 15 1.5-1.5'],
  cube: ['m21 7.5-9-5-9 5 9 5 9-5Z', 'M3 7.5v9l9 5 9-5v-9', 'M12 12.5v9'],
  wallet: ['M3 7a2 2 0 0 1 2-2h13v4', 'M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2Z', 'M16 14.5h.01'],
  folder: ['M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z'],
  book: ['M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5Z', 'M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5'],
  logout: ['M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3', 'M10 17l-5-5 5-5', 'M5 12h11'],
  copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
  refresh: ['M20 11a8 8 0 0 0-14.7-4.4L3 9', 'M3 4v5h5', 'M4 13a8 8 0 0 0 14.7 4.4L21 15', 'M21 20v-5h-5'],
  plus: ['M12 5v14', 'M5 12h14'],
  external: ['M14 4h6v6', 'M20 4 11 13', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  sun: ['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M12 2v2', 'M12 20v2', 'm4.9 4.9 1.4 1.4', 'm17.7 17.7 1.4 1.4', 'M2 12h2', 'M20 12h2', 'm4.9 19.1 1.4-1.4', 'm17.7 6.3 1.4-1.4'],
  globe: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M2 12h20', 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z'],
  moon: ['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z'],
  check: ['m5 12.5 4.5 4.5L19 7.5'],
  alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M12 16v-4', 'M12 8h.01'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z', 'm9 12 2 2 4-4'],
  zap: ['M13 2 3 14h9l-1 8 10-12h-9l1-8Z'],
  chart: ['M3 3v18h18', 'M8 17v-5', 'M13 17V8', 'M18 17v-9'],
  arrowRight: ['M5 12h14', 'm13 6 6 6-6 6'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  download: ['M12 4v12', 'm7 11 5 5 5-5', 'M5 20h14'],
  code: ['m8 7-5 5 5 5', 'm16 7 5 5-5 5'],
  branch: ['M6 3v12', 'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M18 9a9 9 0 0 1-9 9'],
  server: ['M3 4h18v6H3z', 'M3 14h18v6H3z', 'M7 7h.01', 'M7 17h.01'],
  layers: ['m12 3 9 5-9 5-9-5 9-5Z', 'm3 13 9 5 9-5'],
  hexagon: ['M12 2.5 20.5 7.3v9.4L12 21.5l-8.5-4.8V7.3Z', 'M12 8.5 15 10.2v3.6L12 15.5l-3-1.7v-3.6Z'],
  bank: ['M12 3 3 8h18Z', 'M5 10v8', 'M9.5 10v8', 'M14.5 10v8', 'M19 10v8', 'M3 21h18'],
  play: ['M7 4.5v15l12-7.5Z'],
  pause: ['M8 5v14', 'M16 5v14']
};

export function Icon({ name, label }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden={label ? undefined : 'true'} role={label ? 'img' : undefined} aria-label={label}>
      {(ICONS[name] ?? ICONS.info).map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

export function Button({ children, onClick, variant = 'secondary', icon, disabled = false, size, type = 'button', title }) {
  const className = ['btn', variant, size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : null].filter(Boolean).join(' ');
  return (
    <button type={type} className={className} onClick={onClick} disabled={disabled} title={title}>
      {icon ? <Icon name={icon} /> : null}{children}
    </button>
  );
}

export const Badge = ({ children, tone = 'neutral' }) => <span className="badge" data-tone={tone}>{children}</span>;

export const Note = ({ children, tone = 'neutral' }) => <p className="note" data-tone={tone}>{children}</p>;

export function Empty({ title, children, action }) {
  return <div className="empty"><strong>{title}</strong><p>{children}</p>{action ?? null}</div>;
}

export function Skeleton({ rows = 3 }) {
  return <div className="skeleton" aria-hidden="true">{Array.from({ length: rows }, (_, i) => <span key={i} />)}</div>;
}

// headers: strings or { text, className }
export function Table({ headers, children }) {
  return (
    <div className="table-scroll">
      <table className="table">
        <thead><tr>{headers.map((header, i) => (
          <th key={i} scope="col" className={typeof header === 'string' ? undefined : header.className}>
            {typeof header === 'string' ? header : header.text}
          </th>
        ))}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function PageHead({ title, description, actions }) {
  return (
    <header className="page-head">
      <div><h1>{title}</h1>{description ? <p>{description}</p> : null}</div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Banner({ title, children, tone = 'neutral', action }) {
  return (
    <div className="banner" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={tone === 'danger' || tone === 'warning' ? 'alert' : 'info'} />
      <div><strong>{title}</strong>{children ? <p>{children}</p> : null}</div>
      {action ?? null}
    </div>
  );
}

// rows: [label, value, rowClass?]; falsy rows are skipped.
export function Kv({ rows, className = 'kv' }) {
  return (
    <dl className={className}>
      {rows.filter(Boolean).map(([label, value, rowClass], i) => [
        <dt key={`t${i}`} className={rowClass}>{label}</dt>,
        <dd key={`d${i}`} className={rowClass}>{value ?? '—'}</dd>
      ])}
    </dl>
  );
}

export function Segmented({ options, value, onChange, label }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={String(option.value === value)} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

async function writeClipboard(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  // Clipboard access is blocked on insecure origins, which includes plain-HTTP
  // staging hosts, so fall back instead of leaving the button dead.
  const area = document.createElement('textarea');
  area.value = value; area.className = 'visually-hidden'; area.readOnly = true;
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

export function CopyButton({ value, label = t('Copy'), className = 'ghost copy' }) {
  const [state, setState] = useState(null);
  const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try { await writeClipboard(value); setState('done'); } catch { setState('error'); }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(null), 1600);
  };
  return (
    <button type="button" className={className} data-state={state ?? undefined} aria-label={t('Copy {0}', label)} onClick={copy}>
      {state === 'done' ? t('Copied') : state === 'error' ? t('Copy failed') : label}
    </button>
  );
}

export function InlineCopy({ value, label = t('Copy'), secret = false, display }) {
  return (
    <div className={'inline-copy' + (secret ? ' secret' : '')}>
      <code title={value}>{display ?? value}</code>
      <CopyButton value={value} label={label} />
    </div>
  );
}

// Code samples with language tabs.
export function CodeBlock({ samples }) {
  const [index, setIndex] = useState(0);
  const current = samples[Math.min(index, samples.length - 1)];
  return (
    <div className="code-block">
      {samples.length > 1 ? (
        <div className="code-tabs" role="tablist">
          {samples.map((sample, i) => (
            <button key={sample.label} type="button" role="tab" aria-selected={String(i === index)} onClick={() => setIndex(i)}>{sample.label}</button>
          ))}
        </div>
      ) : null}
      <pre><code>{current.code}</code></pre>
      <CopyButton value={current.code} label={t('Copy')} className="ghost copy code-copy" />
    </div>
  );
}

export function ProviderMark({ provider }) {
  return <span className="provider-mark" aria-hidden="true" style={{ background: PROVIDER_COLORS[provider] ?? '#52525b' }}>{(provider ?? '?').slice(0, 1)}</span>;
}

export const Mono = ({ value, title }) => <code className="mono" title={title ?? value}>{value}</code>;

export const ExternalLink = ({ href, children }) => <a className="ghost" href={href} target="_blank" rel="noopener noreferrer">{children}</a>;

// <dialog> gives focus trapping, Esc dismissal and an inert background. The
// parent mounts it while open; closing (Esc, backdrop for drawers) calls onClose
// unless `locked` keeps it open while a wallet request is in flight.
export function Modal({ label, onClose, className, children, locked = false, backdropCloses = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog.open) dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return (
    <dialog ref={ref} className={className} aria-label={label}
      onCancel={(event) => { event.preventDefault(); if (!locked) onClose(); }}
      onClick={(event) => { if (backdropCloses && event.target === ref.current) onClose(); }}>
      {children}
    </dialog>
  );
}

export function Drawer({ label, title, onClose, children }) {
  return (
    <Modal className="drawer" label={label} onClose={onClose} backdropCloses>
      <div className="drawer-head">
        {title}
        <button className="ghost" type="button" aria-label={t('Close')} onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="drawer-body">{children}</div>
    </Modal>
  );
}

export function Stat({ label, value, unit, foot }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}{unit ? <small>{unit}</small> : null}</span>
      {foot ? <span className="stat-foot">{foot}</span> : null}
    </div>
  );
}
