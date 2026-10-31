// Runs read(registry) at most once per interval and replays the samples it
// added into the registries in between. A read that throws caches nothing, so
// the next scrape tries again.
export function replayedSamples(intervalMs, read, now = Date.now) {
  let cache = null;
  return async (registry) => {
    if (cache && now() - cache.at < intervalMs) { for (const sample of cache.samples) registry.add(...sample); return; }
    const samples = [];
    await read({ add: (...sample) => { samples.push(sample); registry.add(...sample); } });
    cache = { at: now(), samples };
  };
}
