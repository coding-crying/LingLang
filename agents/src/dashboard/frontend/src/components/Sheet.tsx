/**
 * Sheet — generic bottom-sheet shell, built on HeroUI's Drawer (which
 * portals, animates, and handles Escape/outside-click dismissal itself —
 * this used to be hand-rolled here, see git history for the old version).
 *
 * Renders only when `activeSheet !== null` (enforced purely by reading
 * AppState's single `activeSheet` slot — that slot is what guarantees only
 * one sheet is ever open at a time, nothing extra needed here). Sheet does
 * not know about sheet *content* — callers pass the content to render via
 * `children`; AppShell is responsible for dispatching on `activeSheet.kind`
 * to pick which content to render.
 */

import type { ReactNode } from 'react';
import { Drawer } from '@heroui/react';
import { useAppState } from '../state/AppState';

interface SheetProps {
  children: ReactNode;
}

export default function Sheet({ children }: SheetProps) {
  const { activeSheet, closeSheet } = useAppState();

  return (
    <Drawer.Backdrop isOpen={activeSheet !== null} onOpenChange={(open) => !open && closeSheet()}>
      <Drawer.Content placement="bottom">
        <Drawer.Dialog>
          <Drawer.Handle />
          <Drawer.Body>{children}</Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
