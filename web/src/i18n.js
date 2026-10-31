// The console is written in English; locales/zh.js translates it. A choice
// saved with the header toggle wins; otherwise the first English or Chinese
// tag in the browser's preferred languages picks (any zh-* reads Chinese),
// and English is the default.
//
//   t('Create key')                       → "Create key" / "创建 Key"
//   t('Refunded {0} USDC', amount)        → positional values fill {0}, {1}…
//
// A string missing from the dictionary shows in English.
import zh from './locales/zh.js';

const LANG_KEY = 'router3:lang';
export const LANGS = ['en', 'zh'];
const DICTIONARIES = { zh };

function saved() {
  try { return globalThis.localStorage?.getItem(LANG_KEY) ?? null; } catch { return null; }
}

export function detectLang(languages = globalThis.navigator?.languages ?? [globalThis.navigator?.language]) {
  const choice = saved();
  if (LANGS.includes(choice)) return choice;
  for (const tag of languages ?? []) {
    const base = String(tag ?? '').toLowerCase().split('-')[0];
    if (LANGS.includes(base)) return base;
  }
  return 'en';
}

export let lang = detectLang();
if (globalThis.document) document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
export const locale = () => (lang === 'zh' ? 'zh-CN' : 'en-US');

export function t(text, ...values) {
  const template = DICTIONARIES[lang]?.[text] ?? text;
  return values.length ? template.replace(/\{(\d+)\}/g, (match, i) => (i < values.length ? String(values[i]) : match)) : template;
}

// Joins sentences: a space between English ones, nothing between Chinese ones.
export function sentences(...parts) {
  return parts.filter(Boolean).join(lang === 'zh' ? '' : ' ');
}

// Module-level strings are evaluated once, so switching reloads the page.
export function setLang(next) {
  if (!LANGS.includes(next) || next === lang) return;
  try { localStorage.setItem(LANG_KEY, next); } catch { /* the choice lasts this page only */ }
  lang = next;
  location.reload();
}

// The API answers in English. Its messages read through the dictionary; codes
// whose message carries a value map to a fixed sentence first.
const CODE_TEXT = { API_KEY_CONCURRENCY_LIMIT: 'Too many requests at once on this API key' };

export function errorText(code, message) {
  const text = CODE_TEXT[code] ?? message;
  return text == null ? text : t(text);
}
