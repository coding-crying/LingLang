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
 * itself no longer mounts a generic `TopBar`.
 */
import { Button, Typography } from '@heroui/react';
import { ChevronDown, Languages } from 'lucide-react';
import { type ReactElement, useEffect } from 'react';
import OnboardingGate from '../OnboardingGate';
import '../app.css';
import '../shell.css';
import { useOnboarding } from '../hooks/useOnboarding';
import ChunkBrowserSheet from '../sheets/ChunkBrowserSheet';
import CurriculumSheet from '../sheets/CurriculumSheet';
import LanguageSheet from '../sheets/LanguageSheet';
import WordDetailSheet from '../sheets/WordDetailSheet';
import { AppStateProvider, useAppState } from '../state/AppState';
import DebugTab from '../tabs/DebugTab';
import LibraryTab from '../tabs/LibraryTab';
import ProfileTab from '../tabs/ProfileTab';
import VoiceTab from '../tabs/VoiceTab';
import Sheet from './Sheet';
import TabBar from './TabBar';
import { LingLangBrand, ThemeToggle } from './TopBar';

function AppShellInner({ onLogout }: { onLogout: () => void }) {
  const {
    activeTab,
    activeSheet,
    closeSheet,
    setTab,
    openSheet,
    bumpContentVersion,
    debugEnabled,
  } = useAppState();
  const onboarding = useOnboarding();
  const isAdmin = onboarding.userId === 'will';
  const canShowDebug = isAdmin && debugEnabled;

  useEffect(() => {
    if (activeTab === 'debug' && !canShowDebug) setTab('voice');
  }, [activeTab, canShowDebug, setTab]);

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
  let otherTabContent: ReactElement | null = null;
  switch (activeTab) {
    case 'library':
      otherTabContent = (
        <LibraryTab userId={onboarding.userId} targetLang={onboarding.targetLang} />
      );
      break;
    case 'profile':
      otherTabContent = <ProfileTab onLogout={onLogout} />;
      break;
    case 'debug':
      otherTabContent = canShowDebug ? <DebugTab /> : null;
      break;
  }

  return (
    <div className="app-shell" data-active-tab={activeTab}>
      <a className="shell-skip-link" href="#app-content">
        Skip to content
      </a>
      <aside className="app-sidebar" aria-label="LingLang">
        <LingLangBrand />
        <TabBar showDebug={canShowDebug} layout="sidebar" />
        <div className="sidebar-footer">
          <Button
            variant="ghost"
            className="sidebar-language"
            aria-label={`Change language, currently ${onboarding.languageName}`}
            onPress={() => openSheet({ kind: 'language' })}
          >
            <Languages size={20} aria-hidden="true" />
            <span className="sidebar-language-copy">
              <span className="sidebar-caption">Learning</span>
              <span className="sidebar-language-name">{onboarding.languageName}</span>
            </span>
            <ChevronDown size={16} aria-hidden="true" />
          </Button>
          <div className="sidebar-account">
            <span className="sidebar-avatar" aria-hidden="true">
              {onboarding.userId.slice(0, 1).toUpperCase()}
            </span>
            <span className="sidebar-user-name">{onboarding.userId}</span>
            <ThemeToggle />
          </div>
        </div>
      </aside>
      <header className="mobile-app-header">
        <LingLangBrand />
        <ThemeToggle />
      </header>
      <main id="app-content" className="app-workspace" tabIndex={-1}>
        {/* Keep the room and transcript alive when another tab is visible. */}
        <div style={{ display: activeTab === 'voice' ? 'contents' : 'none' }}>
          <VoiceTab userId={onboarding.userId} targetLang={onboarding.targetLang} />
        </div>
        {otherTabContent}
      </main>
      <TabBar showDebug={canShowDebug} />
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
            onBrowseParts={(sourceId, sourceTitle) =>
              openSheet({ kind: 'chunkBrowser', sourceId, sourceTitle })
            }
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
        ) : activeSheet?.kind === 'wordDetail' ? (
          <WordDetailSheet
            wordId={activeSheet.wordId}
            targetLang={onboarding.targetLang}
            onClose={closeSheet}
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
