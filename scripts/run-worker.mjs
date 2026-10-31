const runtime = process.argv[2];
if (!['collector', 'reconciler'].includes(runtime)) {
  console.error('Usage: node scripts/run-worker.mjs <collector|reconciler>');
  process.exit(2);
}
process.env.MCG_RUNTIME = runtime;
await import('../src/runtime.js');
