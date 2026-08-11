/**
 * AppShell — the top-level authed screen: mounts AppStateProvider, gates
 * the whole app behind the onboarding check, and lays out active tab
 * content + TabBar + Sheet.
 *
 * The onboarding gate (via `useOnboarding()`, extracted from VoiceRoom.tsx)
 * covers the ENTIRE tabbed app — a user who hasn't onboarded sees
 * `OnboardingGate` before any tab renders, regardless of which tab
 * `activeTab` would otherwise select.
 *
 * Every tab renders its own header content (VoiceTab: language/curriculum/
 * streak pills; LibraryTab/ProfileTab: their own `<h2>`), so AppShell
 * itself no longer mounts a generic `TopBar`. Sheet content beyond
 * `language` is still a placeholder.
 */

import type { ReactElement } from 'react';
import { Button, Typography } from '@heroui/react';
import { AppStateProvider, useAppState } from '../state/AppState';
import { useOnboarding } from '../hooks/useOnboarding';
import TabBar from './TabBar';
import Sheet from './Sheet';
import OnboardingGate from '../OnboardingGate';
import VoiceTab from '../tabs/VoiceTab';
import ProfileTab from '../tabs/ProfileTab';
import LibraryTab from '../tabs/LibraryTab';
import DebugTab from '../tabs/DebugTab';
import LanguageSheet from '../sheets/LanguageSheet';
import CurriculumSheet from '../sheets/CurriculumSheet';
import ChunkBrowserSheet from '../sheets/ChunkBrowserSheet';
import '../app.css';

function AppShellInner({ onLogout }: { onLogout: () => void }) {
  const { activeTab, activeSheet, closeSheet, setTab, openSheet, bumpContentVersion } = useAppState();
  const onboarding = useOnboarding();

  if (!onboarding.checked) {
    return <div className="loading-wrap">Loading…</div>;
  }

  if (!onboarding.targetLang) {
    return (
      <div className="onboarding-wrap">
        <div className="onboarding-card">
          <Typography.Heading level={2}>Choose a language</Typography.Heading>
          <Typography.Paragraph style={{ color: 'var(--muted)' }}>
            Pick the language you want to learn to get started.
          </Typography.Paragraph>
          <Button variant="primary" onPress={() => openSheet({ kind: 'language' })}>
            Choose language
          </Button>
        </div>
        <Sheet>
          {activeSheet?.kind === 'language' && (
            <LanguageSheet
              userId={onboarding.userId}
              currentLang={onboarding.targetLang}
              onSwitched={onboarding.refresh}
              onClose={closeSheet}
            />
          )}
        </Sheet>
      </div>
    );
  }

  if (onboarding.needsOnboarding) {
    // The gate takes over the whole screen, so the Sheet has to be mounted
    // here too — otherwise "Change language" would open a sheet that only
    // exists in the tabbed layout below, i.e. nothing would happen.
    return (
      <>
        <OnboardingGate
          userId={onboarding.userId}
          targetLanguage={onboarding.targetLang}
          languageName={onboarding.languageName!}
          onComplete={onboarding.markComplete}
          onSkipToVoice={onboarding.markComplete}
          onChangeLanguage={() => openSheet({ kind: 'language' })}
        />
        <Sheet>
          {activeSheet?.kind === 'language' && (
            <LanguageSheet
              userId={onboarding.userId}
              currentLang={onboarding.targetLang}
              onSwitched={onboarding.refresh}
              onClose={closeSheet}
            />
          )}
        </Sheet>
      </>
    );
  }

  // Admin-only debug surface. This is cosmetic gating — GET /api/runtime
  // enforces the same check server-side, so a forced tab shows nothing.
  const isAdmin = onboarding.userId === 'will';

  let otherTabContent: ReactElement | null = null;
  switch (activeTab) {
    case 'library':
      otherTabContent = <LibraryTab />;
      break;
    case 'profile':
      otherTabContent = <ProfileTab onLogout={onLogout} />;
      break;
    case 'debug':
      otherTabContent = isAdmin ? <DebugTab /> : null;
      break;
  }

  return (
    <div className="app-shell">
      {/* VoiceTab stays mounted across tab switches so its LiveKitRoom
          connection (and useConversationStream transcript state) survives
          navigating to Library/Profile and back — it used to unmount
          entirely here, silently dropping any live voice session. */}
      <div style={{ display: activeTab === 'voice' ? 'contents' : 'none' }}>
        <VoiceTab userId={onboarding.userId} targetLang={onboarding.targetLang} />
      </div>
      {otherTabContent}
      <TabBar showDebug={isAdmin} />
      <Sheet>
        {activeSheet?.kind === 'language' ? (
          <LanguageSheet
            userId={onboarding.userId}
            currentLang={onboarding.targetLang}
            onSwitched={onboarding.refresh}
            onClose={closeSheet}
          />
        ) : activeSheet?.kind === 'curriculum' ? (
          <CurriculumSheet
            userId={onboarding.userId}
            targetLang={onboarding.targetLang}
            onGoToLibrary={() => {
              closeSheet();
              setTab('library');
            }}
            onBrowseParts={(sourceId, sourceTitle) => openSheet({ kind: 'chunkBrowser', sourceId, sourceTitle })}
          />
        ) : activeSheet?.kind === 'chunkBrowser' ? (
          <ChunkBrowserSheet
            sourceId={activeSheet.sourceId}
            sourceTitle={activeSheet.sourceTitle}
            onJumped={() => {
              bumpContentVersion();
              closeSheet();
            }}
          />
        ) : (
          activeSheet && <div>Sheet: {activeSheet.kind}</div>
        )}
      </Sheet>
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
