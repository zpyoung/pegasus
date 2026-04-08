import { useEffect, useRef, type RefObject } from 'react';

const NEAR_BOTTOM_THRESHOLD = 50;

/**
 * Automatically scrolls the referenced element to the bottom when new content
 * arrives, but only if the user is already near the bottom (within 50px).
 */
export function useAutoScroll(ref: RefObject<HTMLElement | null>, deps: unknown[]): void {
  const isNearBottomRef = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      isNearBottomRef.current = scrollHeight - scrollTop - clientHeight <= NEAR_BOTTOM_THRESHOLD;
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !isNearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
