/**
 * Sheet — generic bottom-sheet shell, portaled to document.body.
 *
 * Renders only when `activeSheet !== null` (enforced purely by reading
 * AppState's single `activeSheet` slot — that slot is what guarantees only
 * one sheet is ever open at a time, nothing extra needed here). Sheet does
 * not know about sheet *content* — callers pass the content to render via
 * `children`; AppShell is responsible for dispatching on `activeSheet.kind`
 * to pick which content to render.
 */

import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAppState } from '../state/AppState';

interface SheetProps {
  children: ReactNode;
}

export default function Sheet({ children }: SheetProps) {
  const { activeSheet, closeSheet } = useAppState();

  useEffect(() => {
    if (!activeSheet) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSheet();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [activeSheet, closeSheet]);

  if (!activeSheet) return null;

  return createPortal(
    <div className="sheet-scrim" onClick={closeSheet}>
      <div className="sheet-panel" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-drag-handle" />
        {children}
      </div>
    </div>,
    document.body,
  );
}
