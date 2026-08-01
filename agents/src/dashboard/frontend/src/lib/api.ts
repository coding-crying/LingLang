/**
 * API base URL + fetch/EventSource helpers.
 *
 * `VITE_API_BASE_URL` defaults to '' (same-origin), which is exactly
 * today's behavior for the dev-proxied and same-origin-served PWA builds —
 * this file changes nothing until the env var is actually set. It exists so
 * a future Capacitor build (loaded from `capacitor://localhost`, a
 * different origin than the Express server) can point at the real deployed
 * API and still get cookies flowing, which requires `credentials: 'include'`
 * on every request.
 */

// `import.meta.env` is a Vite injection: under plain node/tsx it is
// undefined, and reading a property off it throws at module load. That
// mattered because the *.test.ts scripts import modules which transitively
// import this one — AppState.test.ts died here before asserting anything.
// Optional chaining costs nothing in a Vite build (the whole expression is
// statically replaced) and keeps this file importable outside a bundler.
export const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL ?? '';

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), { ...init, credentials: 'include' });
}

export function apiEventSource(path: string): EventSource {
  return new EventSource(apiUrl(path), { withCredentials: true });
}
