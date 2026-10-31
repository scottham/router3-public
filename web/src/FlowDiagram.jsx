import { memo, useEffect, useMemo, useState } from 'react';
import { BaseEdge, Background, EdgeLabelRenderer, Handle, Position, ReactFlow, getSmoothStepPath } from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { Icon } from './ui.jsx';
import { t } from './i18n.js';

// The landing page's live diagram: who calls, who meters, where the money sits
// and where it goes, played back step by step. Deliberately abstract: internal
// services are folded into one gateway node. It reads no data and the canvas
// does not respond to drag or zoom.

const NODES = {
  app: { icon: 'code', title: 'Your app', sub: 'OpenAI / Anthropic SDK · API Key', lane: 'call' },
  gateway: { icon: 'shield', title: 'Router 3', sub: t('Hold · meter · charge actual cost'), lane: 'call' },
  provider: { icon: 'server', title: 'Models', sub: 'DeepSeek · OpenRouter', lane: 'call' },
  wallet: { icon: 'wallet', title: 'Wallet', sub: t('Self-custody · signs only'), lane: 'user' },
  pool: { icon: 'hexagon', title: t('Prepaid pool'), sub: t('Monad contract · yours, withdraw any time'), lane: 'chain' },
  treasury: { icon: 'bank', title: 'Treasury', sub: 'USDC', lane: 'settle' }
};

// [id, source, target, label, wide handles, narrow handles]
const EDGES = [
  ['fund', 'wallet', 'pool', t('auto refill'), ['r', 'l'], ['l', 'r']],
  ['call', 'app', 'gateway', 'API Key', ['r', 'l'], ['b', 't']],
  ['route', 'gateway', 'provider', 'route', ['r', 'l'], ['r', 'l']],
  ['settle', 'gateway', 'pool', t('batched debit'), ['b', 't'], ['b', 't']],
  ['pay', 'pool', 'treasury', 'sweep', ['r', 'l'], ['b', 't']]
];

const LAYOUTS = {
  wide: {
    width: 210,
    at: { app: [0, 0], gateway: [320, 0], provider: [640, 0],
      wallet: [0, 190], pool: [320, 190], treasury: [640, 190] }
  },
  narrow: {
    width: 152,
    at: { app: [0, 0], gateway: [0, 140], provider: [172, 140],
      pool: [0, 280], wallet: [172, 280], treasury: [0, 420] }
  }
};

// One run: which edge fires at each step, and what it means.
const STEPS = [
  { edge: 'fund', text: t('Sign once, no gas: the pool refills from your wallet as you use it, within your daily limit') },
  { edge: 'call', text: t('Call with any of your API keys; the gateway holds an estimate of the cost against the pool') },
  { edge: 'route', text: t('Routed to the provider and charged by actual tokens; the rest of the hold is released') },
  { edge: 'settle', text: t('Charges are debited on-chain in batches, together with the next refill; no transaction per call') },
  { edge: 'pay', text: t('Debited usage is swept to the Treasury; the rest of the pool only goes back to your wallet') }
];

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function useLayout() {
  const query = '(max-width: 760px)';
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const list = matchMedia(query);
    const onChange = () => setNarrow(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);
  return narrow ? 'narrow' : 'wide';
}

const HANDLE = { t: Position.Top, b: Position.Bottom, l: Position.Left, r: Position.Right };

const StepNode = memo(function StepNode({ data }) {
  const { spec, status, compact } = data;
  return (
    <div className="flow-node" data-lane={spec.lane} data-status={status} data-compact={compact || undefined}>
      {Object.entries(HANDLE).map(([id, position]) => (
        <span key={id}>
          <Handle type="target" id={`${id}-in`} position={position} isConnectable={false} />
          <Handle type="source" id={`${id}-out`} position={position} isConnectable={false} />
        </span>
      ))}
      <div className="flow-node-head">
        <span className="flow-node-icon"><Icon name={spec.icon} /></span>
        <strong>{spec.title}</strong>
        <span className="flow-node-state" aria-hidden="true">{status === 'done' ? <Icon name="check" /> : null}</span>
      </div>
      <p>{spec.sub}</p>
    </div>
  );
});

function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 12 });
  return (
    <>
      <BaseEdge id={id} path={path} className="flow-edge" data-status={data.status} />
      {data.status === 'running' ? (
        <circle r="4" className="flow-pulse">
          <animateMotion dur="1.1s" repeatCount="indefinite" path={path} />
        </circle>
      ) : null}
      {data.showLabel ? (
        <EdgeLabelRenderer>
          <span className="flow-edge-label nodrag nopan" data-status={data.status}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>{data.label}</span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const nodeTypes = { step: StepNode };
const edgeTypes = { flow: FlowEdge };

export function FlowDiagram() {
  const layout = useLayout();
  const [step, setStep] = useState(() => reducedMotion() ? STEPS.length : 0);
  const [playing, setPlaying] = useState(() => !reducedMotion());

  useEffect(() => {
    if (!playing) return undefined;
    // The finished state holds a little longer before the next run starts.
    const timer = setTimeout(() => setStep((current) => current >= STEPS.length ? 0 : current + 1), step >= STEPS.length ? 3200 : 1700);
    return () => clearTimeout(timer);
  }, [playing, step]);

  const { nodes, edges } = useMemo(() => {
    const { at, width } = LAYOUTS[layout];
    const order = STEPS.map((item) => item.edge);
    const edgeStatus = (edgeId) => {
      const index = order.indexOf(edgeId);
      return index < step ? 'done' : index === step ? 'running' : 'idle';
    };
    const touched = new Map();
    for (const [edgeId, source, target] of EDGES) {
      const status = edgeStatus(edgeId);
      for (const node of [source, target]) {
        const previous = touched.get(node);
        if (status === 'running' || (status === 'done' && previous !== 'running')) touched.set(node, status);
      }
    }
    return {
      nodes: Object.entries(NODES).map(([id, spec]) => ({
        id, type: 'step', position: { x: at[id][0], y: at[id][1] }, style: { width },
        data: { spec, status: touched.get(id) ?? 'idle', compact: layout === 'narrow' }, draggable: false, selectable: false
      })),
      edges: EDGES.map(([id, source, target, label, wide, narrow]) => {
        const [from, to] = layout === 'wide' ? wide : narrow;
        return { id, source, target, sourceHandle: `${from}-out`, targetHandle: `${to}-in`, type: 'flow',
          data: { label, status: edgeStatus(id), showLabel: layout === 'wide' } };
      })
    };
  }, [layout, step]);

  const current = STEPS[Math.min(step, STEPS.length - 1)];
  const finished = step >= STEPS.length;
  return (
    <figure className="flow" data-layout={layout}>
      <figcaption className="flow-bar">
        <span className="flow-run" data-state={finished ? 'done' : 'running'}>
          <span className="flow-run-dot" aria-hidden="true" />{finished ? 'done' : `${step + 1}/${STEPS.length}`}
        </span>
        <span className="flow-caption" aria-live="polite">{finished ? t('sign once → call → charge → debit → sweep') : current.text}</span>
        <button type="button" className="ghost flow-toggle" onClick={() => {
          if (!playing && finished) setStep(0);
          setPlaying(!playing);
        }} aria-label={playing ? t('Pause') : t('Play')}>
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
      </figcaption>
      <div className="flow-canvas" style={{ height: layout === 'wide' ? 340 : 600 }}>
        <ReactFlow key={layout} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          fitView fitViewOptions={{ padding: layout === 'wide' ? 0.06 : 0.04 }} minZoom={0.2}
          nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} nodesFocusable={false} edgesFocusable={false}
          panOnDrag={false} panOnScroll={false} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} preventScrolling={false}
          proOptions={{ hideAttribution: true }} aria-label={t('Call and settlement flow')}>
          <Background variant="dots" gap={18} size={1.2} className="flow-dots" />
        </ReactFlow>
      </div>
      <ol className="visually-hidden">{STEPS.map((item) => <li key={item.edge}>{item.text}</li>)}</ol>
    </figure>
  );
}
