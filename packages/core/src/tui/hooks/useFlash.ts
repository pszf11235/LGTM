/**
 * useFlash — temporary status bar messages that auto-clear.
 *
 * Shows a colored message for 3 seconds (or until next action),
 * then reverts to the default status hints.
 */

import { useState, useCallback, useRef } from "react";

interface Flash {
  text: string;
  color: "green" | "red" | "yellow" | "cyan" | "gray";
}

interface FlashResult {
  /** Current flash message (null if none active) */
  flash: Flash | null;

  /** Show a flash message. Auto-clears after duration (default 3s). */
  showFlash: (text: string, color?: Flash["color"]) => void;

  /** Manually clear the flash (e.g., on next keypress) */
  clearFlash: () => void;
}

/**
 * Create a flash message hook.
 *
 * @param duration - Auto-clear duration in ms (default: 3000)
 */
export function useFlash(duration = 3000): FlashResult {
  const [flash, setFlash] = useState<Flash | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showFlash = useCallback((text: string, color: Flash["color"] = "green") => {
    // Clear any existing timer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    setFlash({ text, color });

    // Auto-clear after duration
    timerRef.current = setTimeout(() => {
      setFlash(null);
      timerRef.current = null;
    }, duration);
  }, [duration]);

  const clearFlash = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setFlash(null);
  }, []);

  return { flash, showFlash, clearFlash };
}
