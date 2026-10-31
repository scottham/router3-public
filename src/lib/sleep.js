// Workers idle between passes. A plain timer would keep a container alive for a
// full interval after SIGTERM, so every wait resolves immediately once the
// runtime abort signal fires.
export function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
