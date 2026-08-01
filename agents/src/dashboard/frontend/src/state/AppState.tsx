/**
 * AppState — top-level React context for the mobile 3-tab shell
 * (Voice / Library / Profile).
 *
 * Holds:
 *   - theme: 'dark' | 'light', persisted to localStorage and mirrored onto
 *     `document.documentElement.dataset.theme` so design-tokens.css's
 *     `[data-theme="dark"|"light"]` selectors apply.
 *   - activeTab: which of the three bottom-nav tabs is showing.
 *   - activeSheet: the single bottom sheet currently open, if any. This is
 *     a single slot (not a stack) by design — calling openSheet() while one
 *     is already open just replaces it, which is what enforces "only one
 *     sheet open at a time."
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { apiFetch } from '../lib/api';

export type Theme = 'dark' | 'light';
export type Tab = 'voice' | 'library' | 'profile';
/** Which backend stack a connect picks — see server.ts's /api/token
 *  `mode` param (`local` = locally hosted pipeline, `cloud` =
 *  Gemini Live). Room names are per-mode (`linglang-<userId>-<mode>`),
 *  so switching this only affects the NEXT connect, never a live session. */
export type ServiceMode = 'local' | 'cloud';

export type SheetState =
  | { kind: 'language' }
  | { kind: 'curriculum' }
  | { kind: 'chunkBrowser'; sourceId: string; sourceTitle: string }
  | { kind: 'wordDetail'; wordId: string }
  | { kind: 'addContent' }
  | { kind: 'voicePicker'; lang: string }
  | { kind: 'emailEdit' };

const THEME_STORAGE_KEY = 'linglang-theme';
const SERVICE_MODE_STORAGE_KEY = 'linglang-service-mode';

/**
 * Cloud is the default for anyone who has never picked a mode. Local needs a
 * GPU speech stack that does not ship with this repo, so on a fresh install
 * it isn't merely offline — it can never come up. Defaulting to it meant a
 * new deployment's first connect went out as `local` and failed, in the
 * window before the health poll bounced it back.
 *
 * Local stays fully available, just opt-in: pick it once and this remembers
 * it, exactly as before.
 */
export function resolveInitialServiceMode(
  storage: Pick<Storage, 'getItem'> | null | undefined,
): ServiceMode {
  const stored = storage?.getItem(SERVICE_MODE_STORAGE_KEY);
  return stored === 'local' ? 'local' : 'cloud';
}

/**
 * Pure theme-resolution logic, split out from the provider so it can be
 * unit-tested without mounting React: localStorage wins if it has a valid
 * value, else prefers-color-scheme, else 'dark'.
 */
export function resolveInitialTheme(
  storage: Pick<Storage, 'getItem'> | null | undefined,
  matchMedia: ((query: string) => { matches: boolean }) | null | undefined,
): Theme {
  const stored = storage?.getItem(THEME_STORAGE_KEY);
  if (stored === 'dark' || stored === 'light') {
    return stored;
  }
  if (matchMedia) {
    try {
      if (matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
      }
      // matchMedia is available and told us definitively it's not a dark
      // preference — but there's no reliable "light" media query symmetric
      // to it (prefers-color-scheme: light is a distinct query), so only
      // trust an explicit light match; otherwise fall through to default.
      if (matchMedia('(prefers-color-scheme: light)').matches) {
        return 'light';
      }
    } catch {
      // matchMedia can throw in non-browser environments; fall through.
    }
  }
  return 'dark';
}

interface AppStateValue {
  theme: Theme;
  activeTab: Tab;
  activeSheet: SheetState | null;
  serviceMode: ServiceMode;
  /** null = health check hasn't resolved yet (don't grey anything out
   *  based on a guess). Polled every LOCAL_HEALTH_POLL_MS via
   *  GET /api/local-health — see server.ts for what "Local" resolves to. */
  localOnline: boolean | null;
  /** True right after an automatic local->cloud switch (see the poll
   *  effect below) so the UI can explain why the mode changed; cleared on
   *  the next manual setServiceMode call. */
  localAutoSwitched: boolean;
  /** Bumped whenever the learner's active content_chunks pointer changes
   *  (Library tile select, chunk-browser jump) — VoiceTab's curriculum
   *  pill depends on this to refetch immediately, since VoiceTab stays
   *  mounted across tab switches (display:none, not unmounted) and would
   *  otherwise only pick up the change on its next activeTab transition. */
  contentVersion: number;
  setTab: (tab: Tab) => void;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  openSheet: (sheet: SheetState) => void;
  closeSheet: () => void;
  setServiceMode: (mode: ServiceMode) => void;
  bumpContentVersion: () => void;
}

const LOCAL_HEALTH_POLL_MS = 20_000;

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() =>
    resolveInitialTheme(
      typeof localStorage === 'undefined' ? null : localStorage,
      typeof window === 'undefined' ? null : window.matchMedia?.bind(window),
    ),
  );
  const [activeTab, setActiveTab] = useState<Tab>('voice');
  const [activeSheet, setActiveSheet] = useState<SheetState | null>(null);
  const [serviceMode, setServiceModeState] = useState<ServiceMode>(() =>
    resolveInitialServiceMode(typeof localStorage === 'undefined' ? null : localStorage),
  );
  const [localOnline, setLocalOnline] = useState<boolean | null>(null);
  const [localAutoSwitched, setLocalAutoSwitched] = useState(false);
  const [contentVersion, setContentVersion] = useState(0);
  // Read inside the poll interval without re-creating it on every mode
  // change — avoids the interval tearing down/restarting on each switch.
  const serviceModeRef = useRef(serviceMode);
  serviceModeRef.current = serviceMode;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(SERVICE_MODE_STORAGE_KEY, serviceMode);
  }, [serviceMode]);

  // Poll local-stack health so the Profile tab can grey out "Local" and so
  // an in-progress "local" selection gets bounced to "cloud" the moment the
  // local GPU stack goes down (stopped for a heavy job, gpu-state off,
  // etc.) rather than silently failing the next connect attempt.
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await apiFetch('/api/local-health');
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        setLocalOnline(data.online);
        if (!data.online && serviceModeRef.current === 'local') {
          setServiceModeState('cloud');
          setLocalAutoSwitched(true);
        }
      } catch {
        // Network hiccup — don't flip localOnline on a single failed poll,
        // next tick will correct it either way.
      }
    };
    check();
    const interval = setInterval(check, LOCAL_HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);
  const toggleTheme = useCallback(
    () => setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark')),
    [],
  );
  const setTab = useCallback((tab: Tab) => setActiveTab(tab), []);
  const openSheet = useCallback((sheet: SheetState) => setActiveSheet(sheet), []);
  const closeSheet = useCallback(() => setActiveSheet(null), []);
  const setServiceMode = useCallback((mode: ServiceMode) => {
    setLocalAutoSwitched(false);
    setServiceModeState(mode);
  }, []);
  const bumpContentVersion = useCallback(() => setContentVersion((v) => v + 1), []);

  const value = useMemo<AppStateValue>(
    () => ({
      theme,
      activeTab,
      activeSheet,
      serviceMode,
      localOnline,
      localAutoSwitched,
      contentVersion,
      setTab,
      toggleTheme,
      setTheme,
      openSheet,
      closeSheet,
      setServiceMode,
      bumpContentVersion,
    }),
    [theme, activeTab, activeSheet, serviceMode, localOnline, localAutoSwitched, contentVersion, setTab, toggleTheme, setTheme, openSheet, closeSheet, setServiceMode, bumpContentVersion],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) {
    throw new Error('useAppState() must be called within an AppStateProvider');
  }
  return ctx;
}
