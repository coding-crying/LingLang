/**
 * TopBar — slot-based header bar reused by the Voice and Library tabs.
 *
 * Accepts `left` / `center` / `right` slots so each tab can plug in its own
 * content (a language pill, a curriculum pill, a streak chip, ...) without
 * TopBar knowing anything about them. The Profile tab renders its own
 * bespoke header instead of using this component.
 *
 * The theme toggle is always rendered as part of the `right` slot area
 * (appended after any caller-supplied `right` content) since every tab that
 * uses TopBar wants it.
 */

import type { ReactNode } from 'react';
import { useAppState } from '../state/AppState';

interface TopBarProps {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
}

export default function TopBar({ left, center, right }: TopBarProps) {
  const { theme, toggleTheme } = useAppState();

  return (
    <header className="top-bar">
      <div className="top-bar-left">{left}</div>
      <div className="top-bar-center">{center}</div>
      <div className="top-bar-right">
        {right}
        <button
          type="button"
          className="theme-toggle"
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? '☾' : '☀'}
        </button>
      </div>
    </header>
  );
}
