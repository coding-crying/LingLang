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

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), { ...init, credentials: 'include' });
}

export function apiEventSource(path: string): EventSource {
  return new EventSource(apiUrl(path), { withCredentials: true });
}
