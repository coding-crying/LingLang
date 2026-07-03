/**
 * AppShell — the top-level authed screen: mounts AppStateProvider and lays
 * out TopBar + active tab content + TabBar + Sheet.
 *
 * For THIS task, tab content and sheet content are placeholders — real tab
 * screens land in Tasks 4/6/7, real sheet content components land in
 * Task 8. AppShell's only job here is the shell/wiring, plus dispatching on
 * `activeTab` / `activeSheet.kind` so those later tasks have a slot to plug
 * into.
 */

import type { ReactElement } from 'react';
import { AppStateProvider, useAppState } from '../state/AppState';
import TabBar from './TabBar';
import TopBar from './TopBar';
import Sheet from './Sheet';
import '../app.css';

function AppShellInner({ onLogout }: { onLogout: () => void }) {
  const { activeTab, activeSheet } = useAppState();

  let tabContent: ReactElement;
  switch (activeTab) {
    case 'voice':
      tabContent = <div>Voice tab</div>;
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
      {activeTab !== 'profile' && <TopBar center={<span>{activeTab}</span>} />}
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
