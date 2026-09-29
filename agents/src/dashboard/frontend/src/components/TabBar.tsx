/** Shared navigation for the mobile tab bar and desktop sidebar. */

import { Button } from '@heroui/react';
import {
  AudioLines,
  BookOpen,
  CircleUserRound,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import { useAppState, type Tab } from '../state/AppState';

interface TabDef {
  tab: Tab;
  label: string;
  icon: LucideIcon;
}

const VOICE: TabDef = { tab: 'voice', label: 'Voice', icon: AudioLines };
const LIBRARY: TabDef = { tab: 'library', label: 'Library', icon: BookOpen };
const PROFILE: TabDef = { tab: 'profile', label: 'Profile', icon: CircleUserRound };
const DEBUG: TabDef = { tab: 'debug', label: 'Debug', icon: SlidersHorizontal };

interface TabBarProps {
  showDebug?: boolean;
  layout?: 'bottom' | 'sidebar';
}

const TABS: Record<NonNullable<TabBarProps['layout']>, TabDef[]> = {
  bottom: [LIBRARY, VOICE, PROFILE],
  sidebar: [VOICE, LIBRARY, PROFILE],
};

export default function TabBar({ showDebug = false, layout = 'bottom' }: TabBarProps) {
  const { activeTab, setTab } = useAppState();
  const tabs = showDebug ? [...TABS[layout], DEBUG] : TABS[layout];

  return (
    <nav
      className={`shell-nav shell-nav--${layout}`}
      aria-label={layout === 'bottom' ? 'Main navigation' : 'Sidebar navigation'}
    >
      {tabs.map(({ tab, label, icon: Icon }) => (
        <Button
          key={tab}
          variant="ghost"
          className="shell-nav-item"
          aria-current={tab === activeTab ? 'page' : undefined}
          onPress={() => setTab(tab)}
        >
          <span className="shell-nav-icon">
            <Icon size={22} strokeWidth={1.8} aria-hidden="true" />
          </span>
          <span>{label}</span>
        </Button>
      ))}
    </nav>
  );
}
