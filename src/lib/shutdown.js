// On SIGTERM (a deploy or `docker stop`) stop accepting requests and let the
// in-flight ones finish. A stream killed mid-flight never sees its usage, so
// its hold is left uncertain and the wallet pauses until it is reconciled.
export function drainOnSignal(app, { signals = ['SIGTERM', 'SIGINT'], exit = (code) => process.exit(code), target = process } = {}) {
  let draining = null;
  const drain = (signal) => {
    if (draining) return draining;
    app.log.info({ signal }, 'draining');
    // Keep-alive sockets that go idle during the drain would otherwise hold
    // the close open for the whole keep-alive timeout.
    const idle = setInterval(() => app.server.closeIdleConnections?.(), 1000);
    draining = app.close().then(() => 0, (error) => { app.log.error({ err: error }, 'close_failed'); return 1; })
      .then((code) => { clearInterval(idle); exit(code); });
    return draining;
  };
  for (const signal of signals) target.once(signal, () => drain(signal));
  return drain;
}
