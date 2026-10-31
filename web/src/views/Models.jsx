import { useState } from 'react';
import { useApp, useLoad } from '../context.js';
import { Badge, Banner, CopyButton, Drawer, Empty, Kv, PageHead, ProviderMark, Skeleton, Table } from '../ui.jsx';
import { formatTokens } from '../format.js';
import { MODEL_SORTS, capabilityLabels, cnyTiers, peakHoursLabel, price, providerLabel } from '../logic.js';
import { sentences, t } from '../i18n.js';

const Capabilities = ({ model }) => (
  <div className="filters">{capabilityLabels(model).map(([label, tone]) => <Badge key={label} tone={tone}>{label}</Badge>)}</div>
);

function ModelDrawer({ model, onClose }) {
  const capabilities = model.capabilities ?? {};
  return (
    <Drawer label={model.public_name} onClose={onClose}
      title={<div className="cell-model"><ProviderMark provider={model.provider} /><h2>{model.public_name}</h2></div>}>
      <div className="inline-copy"><code>{model.public_name}</code><CopyButton value={model.public_name} label={t('Copy model ID')} /></div>
      <div className="drawer-section">
        <h3>{capabilities.offPeakRates ? t('Peak prices (USDC / 1M tokens)') : t('Prices (USDC / 1M tokens)')}</h3>
        <Kv rows={[
          [cnyTiers(capabilities) ? t('Input (from)') : t('Input'), price(model.customer_input_usdc_nano_per_million)],
          [t('Cached input'), price(model.customer_cached_input_usdc_nano_per_million)],
          [t('Output'), price(model.customer_output_usdc_nano_per_million)],
          capabilities.reasoningIncludedInOutput === false ? [t('Reasoning'), price(model.customer_reasoning_usdc_nano_per_million)] : null,
          model.service_fee_bps != null ? [t('Service fee'), t('{0}% of the model cost', model.service_fee_bps / 100)] : null
        ]} />
      </div>
      {capabilities.offPeakRates ? (
        <div className="drawer-section">
          <h3>{t('Off-peak prices (USDC / 1M tokens)')}</h3>
          <Kv rows={[[t('Input'), price(capabilities.offPeakRates.input)], [t('Cached input'), price(capabilities.offPeakRates.cachedInput)],
            [t('Output'), price(capabilities.offPeakRates.output)]]} />
          <p className="note">{t('Priced by when the request starts. Peak is {0} Beijing time on workdays; other times, weekends included, use off-peak prices. Holds use peak prices.', peakHoursLabel(capabilities.peakHoursUtc))}</p>
        </div>
      ) : null}
      <div className="drawer-section">
        <h3>{t('Capabilities')}</h3>
        <Kv rows={[
          [t('Provider'), providerLabel(model.provider)],
          [t('Context length'), capabilities.contextLength ? `${formatTokens(capabilities.contextLength)} tokens` : '—'],
          [t('Max output'), capabilities.maxOutputTokens ? `${formatTokens(capabilities.maxOutputTokens)} tokens` : '—'],
          [t('Modality'), model.modality ?? 'text'],
          capabilities.upstreamModelVersion ? [t('Serving version'), capabilities.upstreamModelVersion] : null
        ]} />
        <Capabilities model={model} />
      </div>
      {cnyTiers(capabilities) ? (
        <div className="drawer-section">
          <h3>{t('Tiered prices (CNY list price per 1M tokens)')}</h3>
          <Table headers={[t('Input length'), { text: t('Input'), className: 'num' }, { text: t('Cached'), className: 'num' }, { text: t('Output'), className: 'num' }, { text: t('Reasoning output'), className: 'num' }]}>
            {(capabilities.priceTiers ?? []).map((tier) => (
              <tr key={tier.lower}>
                <td>{formatTokens(tier.lower)}–{tier.upper == null ? t('no limit') : formatTokens(tier.upper)}</td>
                <td className="num">¥{Number(tier.input) / 1e9}</td>
                <td className="num">{tier.cachedInput == null ? '—' : `¥${Number(tier.cachedInput) / 1e9}`}</td>
                <td className="num">¥{Number(tier.output) / 1e9}</td>
                <td className="num">{tier.thinkingOutput == null ? '—' : `¥${Number(tier.thinkingOutput) / 1e9}`}</td>
              </tr>
            ))}
          </Table>
          <p className="note">{t('The whole tier rate applies by actual input length. 1 USDC counts as 1 USD; now 1 USD = {0} CNY{1}. Every call keeps the price and rate version it used.', capabilities.fx?.cnyPerUsd ?? '—', capabilities.fx?.date ? t(' ({0})', capabilities.fx.date) : '')}</p>
        </div>
      ) : null}
      {capabilities.pricingPolicy === 'published-peak-tariff' || capabilities.peakTariff
        ? <p className="note">{t("Billed at the provider's published peak rate; off-peak discounts do not apply automatically.")}</p> : null}
      <p className="note">{t('Every listed model is priced and was callable at the last catalog check.')}</p>
    </Drawer>
  );
}

export function Models() {
  const app = useApp();
  const { data: models, loading, error } = useLoad(() => app.ensureModels(), []);
  const [term, setTerm] = useState('');
  const [provider, setProvider] = useState('');
  const [sort, setSort] = useState('name');
  const [selected, setSelected] = useState(null);
  if (loading) return <Skeleton rows={6} />;
  if (error) return <Banner title={t('Cannot load the model catalog')} tone="danger">{error.message}</Banner>;
  const query = term.trim().toLowerCase();
  const visible = models
    .filter((model) => (!provider || model.provider === provider)
      && (!query || model.public_name.toLowerCase().includes(query) || providerLabel(model.provider).toLowerCase().includes(query)))
    .sort(MODEL_SORTS[sort].compare);
  const fee = models.find((model) => model.service_fee_bps != null)?.service_fee_bps;
  return (
    <div className="stack">
      <PageHead title={t('Models')} description={sentences(t('Prices in USDC per 1M tokens at the provider\'s price.'), fee != null ? t('Each call adds a {0}% service fee on the model cost.', fee / 100) : null, t('Click a model for details.'))} />
      <div className="toolbar">
        <input type="search" className="input-search" placeholder={t('Search models…')} aria-label={t('Search models')} value={term} onChange={(event) => setTerm(event.target.value)} />
        <select aria-label={t('Filter by provider')} value={provider} onChange={(event) => setProvider(event.target.value)}>
          <option value="">{t('All providers')}</option>
          {[...new Set(models.map((model) => model.provider))].sort().map((name) => <option key={name} value={name}>{providerLabel(name)}</option>)}
        </select>
        <select aria-label={t('Sort')} value={sort} onChange={(event) => setSort(event.target.value)}>
          {Object.entries(MODEL_SORTS).map(([value, spec]) => <option key={value} value={value}>{t('Sort: ')}{spec.label}</option>)}
        </select>
        <span className="spacer" />
        <span className="note">{t('{0} / {1} models', visible.length, models.length)}</span>
      </div>
      <section className="card flush">
        {!visible.length ? <Empty title={t('No matching models')}>{t('Try another keyword or provider.')}</Empty> : (
          <Table headers={[t('Model'), { text: t('Context'), className: 'num hide-sm' }, { text: t('Input'), className: 'num' }, { text: t('Output'), className: 'num' },
            { text: t('Cached input'), className: 'num hide-sm' }, { text: t('Capabilities'), className: 'hide-sm' }, '']}>
            {visible.map((model) => (
              <tr key={model.id ?? model.public_name} data-clickable="" tabIndex={0}
                onClick={(event) => { if (!event.target.closest('button')) setSelected(model); }}
                onKeyDown={(event) => { if (event.key === 'Enter' && event.target === event.currentTarget) setSelected(model); }}>
                <td><div className="cell-model"><ProviderMark provider={model.provider} />
                  <div className="cell-stack"><strong>{model.public_name}</strong><small>{providerLabel(model.provider)}</small></div></div></td>
                <td className="num hide-sm">{model.capabilities?.contextLength ? formatTokens(model.capabilities.contextLength) : '—'}</td>
                <td className="num">{price(model.customer_input_usdc_nano_per_million)}</td>
                <td className="num">{price(model.customer_output_usdc_nano_per_million)}</td>
                <td className="num hide-sm">{price(model.customer_cached_input_usdc_nano_per_million)}</td>
                <td className="hide-sm"><Capabilities model={model} /></td>
                <td className="actions"><CopyButton value={model.public_name} label={t('Copy ID')} /></td>
              </tr>
            ))}
          </Table>
        )}
      </section>
      {selected ? <ModelDrawer model={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}
