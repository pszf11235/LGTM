/**
 * useScrollableList — shared hook for viewport-clipped scrollable lists.
 *
 * Handles: cursor navigation, viewport scrolling, page up/down, go top/bottom.
 * Auto-scrolls to keep the selected item visible within the viewport.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { useStdout } from "ink";

interface ScrollableListResult<T> {
  /** Currently selected index (in the full items array) */
  selectedIdx: number;

  /** Set selected index directly */
  setSelectedIdx: (idx: number) => void;

  /** Items visible in the current viewport */
  visibleItems: T[];

  /** Scroll offset (index of the first visible item) */
  scrollOffset: number;

  /** Total number of items */
  total: number;

  /** Height of the viewport (items that fit) */
  viewportHeight: number;

  /** Navigation functions */
  moveDown: () => void;
  moveUp: () => void;
  pageDown: () => void;
  pageUp: () => void;
  goTop: () => void;
  goBottom: () => void;

  /** Position string for status bar (e.g., "12/47") */
  position: string;
}

/**
 * Create a scrollable list with viewport clipping.
 *
 * @param items - Full list of items
 * @param opts - Options: reservedLines (lines taken by header/status/etc.)
 */
export function useScrollableList<T>(
  items: T[],
  opts?: { reservedLines?: number }
): ScrollableListResult<T> {
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const reservedLines = opts?.reservedLines ?? 7; // title(1) + tabs(1) + context(1) + separator(1) + header(2) + status(1)
  const viewportHeight = Math.max(1, termHeight - reservedLines);

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Clamp selectedIdx if items change
  useEffect(() => {
    if (items.length === 0) {
      setSelectedIdx(0);
      setScrollOffset(0);
    } else if (selectedIdx >= items.length) {
      setSelectedIdx(items.length - 1);
    }
  }, [items.length]);

  // Auto-scroll to keep selection visible
  useEffect(() => {
    if (selectedIdx < scrollOffset) {
      setScrollOffset(selectedIdx);
    } else if (selectedIdx >= scrollOffset + viewportHeight) {
      setScrollOffset(selectedIdx - viewportHeight + 1);
    }
  }, [selectedIdx, viewportHeight]);

  const moveDown = useCallback(() => {
    setSelectedIdx((prev) => Math.min(prev + 1, items.length - 1));
  }, [items.length]);

  const moveUp = useCallback(() => {
    setSelectedIdx((prev) => Math.max(prev - 1, 0));
  }, []);

  const pageDown = useCallback(() => {
    const halfPage = Math.floor(viewportHeight / 2);
    setSelectedIdx((prev) => Math.min(prev + halfPage, items.length - 1));
  }, [viewportHeight, items.length]);

  const pageUp = useCallback(() => {
    const halfPage = Math.floor(viewportHeight / 2);
    setSelectedIdx((prev) => Math.max(prev - halfPage, 0));
  }, [viewportHeight]);

  const goTop = useCallback(() => {
    setSelectedIdx(0);
  }, []);

  const goBottom = useCallback(() => {
    setSelectedIdx(items.length - 1);
  }, [items.length]);

  const visibleItems = useMemo(
    () => items.slice(scrollOffset, scrollOffset + viewportHeight),
    [items, scrollOffset, viewportHeight]
  );

  const position = items.length > 0
    ? `${selectedIdx + 1}/${items.length}`
    : "0/0";

  return {
    selectedIdx,
    setSelectedIdx,
    visibleItems,
    scrollOffset,
    total: items.length,
    viewportHeight,
    moveDown,
    moveUp,
    pageDown,
    pageUp,
    goTop,
    goBottom,
    position,
  };
}
