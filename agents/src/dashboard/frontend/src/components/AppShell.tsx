/**
 * AppShell — the top-level authed screen: mounts AppStateProvider, gates
 * the whole app behind the onboarding check, and lays out active tab
 * content + TabBar + Sheet.
 *
 * Task 4b wires in: the onboarding gate (via `useOnboarding()`, extracted
 * from VoiceRoom.tsx) covering the ENTIRE tabbed app — a user who hasn't
 * onboarded sees `OnboardingGate` before any tab renders, regardless of
 * which tab `activeTab` would otherwise select — and the real `VoiceTab`
 * screen in place of the Voice placeholder.
 *
 * Library/Profile tab content is still a placeholder — those land in
 * Tasks 6/7. Sheet content is still a placeholder — that lands in Task 8.
 * `VoiceTab` renders its own `TopBar` (language/curriculum/streak pills),
 * so AppShell only renders the generic `TopBar` for the tabs that don't
 * supply their own yet (Library today; Profile intentionally never uses
 * TopBar per Task 2).
 */

import type { ReactElement } from 'react';
import { AppStateProvider, useAppState } from '../state/AppState';
import { useOnboarding } from '../hooks/useOnboarding';
import TabBar from './TabBar';
import TopBar from './TopBar';
import Sheet from './Sheet';
import OnboardingGate from '../OnboardingGate';
import VoiceTab from '../tabs/VoiceTab';
import '../app.css';

function AppShellInner({ onLogout }: { onLogout: () => void }) {
  const { activeTab, activeSheet } = useAppState();
  const onboarding = useOnboarding();

  if (!onboarding.checked) {
    return <div className="loading-wrap">Loading…</div>;
  }

  if (onboarding.needsOnboarding) {
    return (
      <OnboardingGate
        userId={onboarding.userId}
        targetLanguage={onboarding.targetLang}
        languageName={onboarding.languageName}
        onComplete={onboarding.markComplete}
        onSkipToVoice={onboarding.markComplete}
      />
    );
  }

  let tabContent: ReactElement;
  switch (activeTab) {
    case 'voice':
      tabContent = <VoiceTab userId={onboarding.userId} targetLang={onboarding.targetLang} />;
      break;
    case 'library':
      tabContent = <div>Library tab</div>;
      break;
    case 'profile':
      tabContent = <div>Profile tab</div>;
      break;
  }

  return (
    <div className="app-shell">
      {activeTab === 'library' && <TopBar center={<span>{activeTab}</span>} />}
      {tabContent}
      <TabBar />
      <Sheet>{activeSheet && <div>Sheet: {activeSheet.kind}</div>}</Sheet>
    </div>
  );
}

export default function AppShell({ onLogout }: { onLogout: () => void }) {
  return (
    <AppStateProvider>
      <AppShellInner onLogout={onLogout} />
    </AppStateProvider>
  );
}
