/** Voice context header and the shared app brand and theme controls. */
import { AudioLines, Moon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAppState } from '../state/AppState';
import IconButton from './IconButton';

interface TopBarProps {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
}

export function LingLangBrand() {
  return (
    <div className="linglang-brand" role="img" aria-label="LingLang">
      <AudioLines size={27} strokeWidth={2.2} aria-hidden="true" />
      <span aria-hidden="true">
        Ling<span>Lang</span>
      </span>
    </div>
  );
}

export function ThemeToggle() {
  const { theme, toggleTheme } = useAppState();
  const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <IconButton className="shell-theme-toggle" label={label} onPress={toggleTheme}>
      {theme === 'dark' ? (
        <Sun size={20} aria-hidden="true" />
      ) : (
        <Moon size={20} aria-hidden="true" />
      )}
    </IconButton>
  );
}

export default function TopBar({ left, center, right }: TopBarProps) {
  return (
    <header className="top-bar">
      <div className="top-bar-left">{left}</div>
      <div className="top-bar-center">{center}</div>
      <div className="top-bar-right">{right}</div>
    </header>
  );
}
