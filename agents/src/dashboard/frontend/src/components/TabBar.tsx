/**
 * TabBar — persistent bottom navigation with 3 tabs.
 *
 * DOM order is Library / Voice / Profile (per the design prototype) so
 * Voice sits visually centered. Reads/writes `activeTab` via
 * `useAppState()`.
 */

import type { ReactElement } from 'react';
import { useAppState, type Tab } from '../state/AppState';

interface TabDef {
  tab: Tab;
  label: string;
  glyph: () => ReactElement;
}

function LibraryGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="3" y="4" width="16" height="2.4" rx="1.2" fill="currentColor" />
      <rect x="3" y="9.8" width="16" height="2.4" rx="1.2" fill="currentColor" />
      <rect x="3" y="15.6" width="10" height="2.4" rx="1.2" fill="currentColor" />
    </svg>
  );
}

function VoiceGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="2" y="8" width="2.6" height="6" rx="1.3" fill="currentColor" />
      <rect x="7" y="4" width="2.6" height="14" rx="1.3" fill="currentColor" />
      <rect x="12" y="1" width="2.6" height="20" rx="1.3" fill="currentColor" />
      <rect x="17" y="6" width="2.6" height="10" rx="1.3" fill="currentColor" />
    </svg>
  );
}

function ProfileGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <circle cx="11" cy="7" r="4" fill="currentColor" />
      <path d="M3 20c0-4.4 3.6-7 8-7s8 2.6 8 7" fill="currentColor" />
    </svg>
  );
}

const TABS: TabDef[] = [
  { tab: 'library', label: 'Library', glyph: LibraryGlyph },
  { tab: 'voice', label: 'Voice', glyph: VoiceGlyph },
  { tab: 'profile', label: 'Profile', glyph: ProfileGlyph },
];

export default function TabBar() {
  const { activeTab, setTab } = useAppState();

  return (
    <nav className="tab-bar">
      {TABS.map(({ tab, label, glyph: Glyph }) => {
        const active = tab === activeTab;
        return (
          <button
            key={tab}
            type="button"
            className="tab-bar-item"
            aria-current={active ? 'page' : undefined}
            onClick={() => setTab(tab)}
            style={{ color: active ? 'var(--accent)' : 'var(--text-faint)' }}
          >
            <Glyph />
            <span className="tab-bar-label">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
