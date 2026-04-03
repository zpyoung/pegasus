import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Hook that detects when the mobile virtual keyboard is open and returns
 * the height offset needed to prevent the keyboard from overlapping content.
 *
 * Uses the Visual Viewport API to detect viewport shrinkage caused by the
 * virtual keyboard. When the keyboard is open, the visual viewport height
 * is smaller than the layout viewport height.
 *
 * @returns An object with:
 * - `keyboardHeight`: The estimated keyboard height in pixels (0 when closed)
 * - `isKeyboardOpen`: Boolean indicating if the keyboard is currently open
 */
export function useVirtualKeyboardResize() {
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
  const initialHeightRef = useRef<number | null>(null);

  const handleViewportResize = useCallback(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    // On first call, record the full viewport height (no keyboard)
    if (initialHeightRef.current === null) {
      initialHeightRef.current = vv.height;
    }

    // The keyboard height is the difference between the window inner height
    // and the visual viewport height. On iOS, window.innerHeight stays the same
    // when the keyboard opens, but visualViewport.height shrinks.
    const heightDiff = window.innerHeight - vv.height;

    // Use a threshold to avoid false positives from browser chrome changes
    // (address bar show/hide causes ~50-80px changes on most browsers)
    const KEYBOARD_THRESHOLD = 100;

    if (heightDiff > KEYBOARD_THRESHOLD) {
      setKeyboardHeight(heightDiff);
      setIsKeyboardOpen(true);
    } else {
      setKeyboardHeight(0);
      setIsKeyboardOpen(false);
    }
  }, []);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    vv.addEventListener('resize', handleViewportResize);
    vv.addEventListener('scroll', handleViewportResize);

    // Initial check
    handleViewportResize();

    return () => {
      vv.removeEventListener('resize', handleViewportResize);
      vv.removeEventListener('scroll', handleViewportResize);
    };
  }, [handleViewportResize]);

  return { keyboardHeight, isKeyboardOpen };
}
