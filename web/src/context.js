import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

// Session-wide state and services every view reads: API client, signed-in
// user, active space, navigation and toasts.
export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

// Loads data for a view and reloads when `deps` change. A slower response never
// overwrites a newer one, and a 401 ends the session instead of showing an error.
export function useLoad(load, deps) {
  const app = useApp();
  const [state, setState] = useState({ loading: true, data: undefined, error: null });
  const token = useRef(0);
  const run = useCallback(async () => {
    const current = ++token.current;
    setState((previous) => ({ ...previous, loading: true }));
    try {
      const data = await load();
      if (current === token.current) setState({ loading: false, data, error: null });
    } catch (error) {
      if (current !== token.current) return;
      if (error?.status === 401) { app.expire(); return; }
      setState({ loading: false, data: undefined, error });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run };
}
