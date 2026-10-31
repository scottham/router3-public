import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Modal } from './ui.jsx';
import { t } from './i18n.js';

// Promise-based dialogs: `await dialogs.form(spec)` resolves with onSubmit's
// result (or null when cancelled); `await dialogs.confirm(spec)` with a boolean.
const DialogContext = createContext(null);
export const useDialogs = () => useContext(DialogContext);

function Control({ spec, inputRef }) {
  if (spec.type === 'select') {
    return (
      <select ref={inputRef} name={spec.name} required={spec.required} multiple={spec.multiple === true}
        size={spec.multiple ? Math.min(6, Math.max(3, spec.options.length)) : undefined}
        defaultValue={spec.multiple ? spec.options.filter((o) => o.selected).map((o) => o.value) : spec.options.find((o) => o.selected)?.value}>
        {spec.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }
  return (
    <input ref={inputRef} name={spec.name} type={spec.type ?? 'text'} defaultValue={spec.value ?? ''} placeholder={spec.placeholder}
      inputMode={spec.inputmode} pattern={spec.pattern} minLength={spec.minLength} maxLength={spec.maxLength}
      required={spec.required} autoComplete="off" />
  );
}

function FormDialog({ spec, done }) {
  const { title, description, submitLabel = t('Create'), fields = [], onSubmit } = spec;
  const inputs = useRef({});
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    for (const field of fields) {
      const input = inputs.current[field.name];
      const missing = field.required && !field.multiple && !input.value.trim();
      input.setCustomValidity(missing ? t('Fill in {0}.', field.label) : (field.validate?.(input.value) ?? ''));
      if (!input.checkValidity()) {
        input.setAttribute('aria-invalid', 'true');
        setError(`${field.label}: ${input.validationMessage}`);
        input.focus();
        return;
      }
      input.removeAttribute('aria-invalid');
    }
    setSubmitting(true);
    try {
      const values = Object.fromEntries(fields.map((field) => {
        const input = inputs.current[field.name];
        return [field.name, field.multiple ? [...input.selectedOptions].map((o) => o.value) : input.value];
      }));
      done(await onSubmit(values));
    } catch (failure) {
      setSubmitting(false);
      const issue = failure.code === 'VALIDATION_ERROR' && Array.isArray(failure.details)
        ? failure.details.find((item) => fields.some((field) => field.name === item.path?.[0])) : null;
      const invalid = issue && fields.find((field) => field.name === issue.path[0]);
      setError(invalid ? `${invalid.label}: ${invalid.validationMessage ?? issue.message}` : failure.message);
      if (invalid) { inputs.current[invalid.name].setAttribute('aria-invalid', 'true'); inputs.current[invalid.name].focus(); }
    }
  }

  return (
    // Esc must not dismiss a form while a wallet request is in flight: doing so
    // would allow another transfer to start before its outcome is known.
    <Modal label={title} onClose={() => done(null)} locked={submitting}>
      <form className="dialog-body" noValidate onSubmit={submit}
        onInput={(event) => { event.target.setCustomValidity?.(''); event.target.removeAttribute('aria-invalid'); setError(null); }}>
        <h2>{title}</h2>
        {description ? <p className="note">{description}</p> : null}
        {fields.map((field, i) => (
          <label className="field" key={field.name}>
            <span className="field-label">{field.label}</span>
            <Control spec={field} inputRef={(node) => {
              inputs.current[field.name] = node;
              if (node && i === 0 && !node.dataset.focused) { node.dataset.focused = '1'; setTimeout(() => node.focus()); }
            }} />
            {field.hint ? <span className="field-hint">{field.hint}</span> : null}
          </label>
        ))}
        {error ? <p className="note" data-tone="danger" role="alert">{error}</p> : null}
        <div className="dialog-foot">
          <button type="button" className="btn secondary" disabled={submitting} onClick={() => done(null)}>{t('Cancel')}</button>
          <button type="submit" className="btn primary" disabled={submitting}>{submitting ? t('Working…') : submitLabel}</button>
        </div>
      </form>
    </Modal>
  );
}

function ConfirmDialog({ spec, done }) {
  const { title, description, confirmLabel = t('Confirm'), tone = 'danger' } = spec;
  return (
    <Modal label={title} onClose={() => done(false)}>
      <div className="dialog-body">
        <h2>{title}</h2>
        <p className="note">{description}</p>
        <div className="dialog-foot">
          <button type="button" className="btn secondary" onClick={() => done(false)}>{t('Cancel')}</button>
          <button type="button" autoFocus className={tone === 'danger' ? 'btn secondary' : 'btn primary'}
            style={tone === 'danger' ? { color: 'var(--danger)' } : undefined} onClick={() => done(true)}>{confirmLabel}</button>
        </div>
      </div>
    </Modal>
  );
}

export function DialogProvider({ children }) {
  const [open, setOpen] = useState([]);
  const counter = useRef(0);
  const show = useCallback((kind, spec) => new Promise((resolve) => {
    const id = ++counter.current;
    setOpen((list) => [...list, { id, kind, spec, done: (value) => {
      setOpen((current) => current.filter((item) => item.id !== id));
      resolve(value);
    } }]);
  }), []);
  const api = useRef({ form: (spec) => show('form', spec), confirm: (spec) => show('confirm', spec), custom: (render) => show('custom', render) });
  return (
    <DialogContext.Provider value={api.current}>
      {children}
      {open.map((item) => item.kind === 'form' ? <FormDialog key={item.id} spec={item.spec} done={item.done} />
        : item.kind === 'confirm' ? <ConfirmDialog key={item.id} spec={item.spec} done={item.done} />
        : <div key={item.id}>{item.spec(item.done)}</div>)}
    </DialogContext.Provider>
  );
}
