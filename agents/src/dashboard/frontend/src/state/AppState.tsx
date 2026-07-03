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
  useState,
  type ReactNode,
} from 'react';

export type Theme = 'dark' | 'light';
export type Tab = 'voice' | 'library' | 'profile';

export type SheetState =
  | { kind: 'language' }
  | { kind: 'curriculum' }
  | { kind: 'wordDetail'; wordId: string }
  | { kind: 'addContent' }
  | { kind: 'voicePicker'; lang: string }
  | { kind: 'emailEdit' };

const THEME_STORAGE_KEY = 'linglang-theme';

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
  setTab: (tab: Tab) => void;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  openSheet: (sheet: SheetState) => void;
  closeSheet: () => void;
}

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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);
  const toggleTheme = useCallback(
    () => setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark')),
    [],
  );
  const setTab = useCallback((tab: Tab) => setActiveTab(tab), []);
  const openSheet = useCallback((sheet: SheetState) => setActiveSheet(sheet), []);
  const closeSheet = useCallback(() => setActiveSheet(null), []);

  const value = useMemo<AppStateValue>(
    () => ({
      theme,
      activeTab,
      activeSheet,
      setTab,
      toggleTheme,
      setTheme,
      openSheet,
      closeSheet,
    }),
    [theme, activeTab, activeSheet, setTab, toggleTheme, setTheme, openSheet, closeSheet],
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
