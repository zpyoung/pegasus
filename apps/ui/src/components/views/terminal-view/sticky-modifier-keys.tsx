import { useCallback } from 'react';
import { cn } from '@/lib/utils';

export type StickyModifier = 'ctrl' | 'alt' | null;

interface StickyModifierKeysProps {
  /** Currently active sticky modifier (null = none) */
  activeModifier: StickyModifier;
  /** Callback when a modifier is toggled */
  onModifierChange: (modifier: StickyModifier) => void;
  /** Whether the terminal is connected */
  isConnected: boolean;
}

/**
 * Sticky modifier keys (Ctrl, Alt) for the terminal toolbar.
 *
 * "Sticky" means: tap a modifier to activate it, then the next key pressed
 * in the terminal will be sent with that modifier applied. After the modified
 * key is sent, the sticky modifier automatically deactivates.
 *
 * - Ctrl: Sends the control code (character code & 0x1f)
 * - Alt: Sends escape prefix (\x1b) before the character
 *
 * Tapping an already-active modifier deactivates it (toggle behavior).
 */
export function StickyModifierKeys({
  activeModifier,
  onModifierChange,
  isConnected,
}: StickyModifierKeysProps) {
  const toggleCtrl = useCallback(() => {
    onModifierChange(activeModifier === 'ctrl' ? null : 'ctrl');
  }, [activeModifier, onModifierChange]);

  const toggleAlt = useCallback(() => {
    onModifierChange(activeModifier === 'alt' ? null : 'alt');
  }, [activeModifier, onModifierChange]);

  return (
    <div className="flex items-center gap-1 shrink-0">
      <ModifierButton
        label="Ctrl"
        isActive={activeModifier === 'ctrl'}
        onPress={toggleCtrl}
        disabled={!isConnected}
        title="Sticky Ctrl – tap to activate, then press a key (e.g. Ctrl+C)"
      />
      <ModifierButton
        label="Alt"
        isActive={activeModifier === 'alt'}
        onPress={toggleAlt}
        disabled={!isConnected}
        title="Sticky Alt – tap to activate, then press a key (e.g. Alt+D)"
      />
    </div>
  );
}

/**
 * Individual modifier toggle button with active state styling.
 */
function ModifierButton({
  label,
  isActive,
  onPress,
  disabled = false,
  title,
}: {
  label: string;
  isActive: boolean;
  onPress: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      className={cn(
        'px-2 py-1 rounded-md text-xs font-medium shrink-0 select-none transition-all min-w-[36px] min-h-[28px] flex items-center justify-center',
        'touch-manipulation border',
        isActive
          ? 'bg-brand-500 text-white border-brand-500 shadow-sm shadow-brand-500/25'
          : 'bg-muted/80 text-foreground hover:bg-accent border-transparent',
        disabled && 'opacity-40 pointer-events-none'
      )}
      onPointerDown={(e) => {
        e.preventDefault(); // Prevent focus stealing from terminal
        onPress();
      }}
      title={title}
      disabled={disabled}
      aria-pressed={isActive}
      role="switch"
    >
      {label}
    </button>
  );
}

/**
 * Apply a sticky modifier to raw terminal input data.
 *
 * For Ctrl: converts printable ASCII characters to their control-code equivalent.
 *   e.g. 'c' → \x03 (Ctrl+C), 'a' → \x01 (Ctrl+A)
 *
 * For Alt: prepends the escape character (\x1b) before the data.
 *   e.g. 'd' → \x1bd (Alt+D)
 *
 * Returns null if the modifier cannot be applied (non-ASCII, etc.)
 */
export function applyStickyModifier(data: string, modifier: StickyModifier): string | null {
  if (!modifier || !data) return null;

  if (modifier === 'ctrl') {
    // Only apply Ctrl to single printable ASCII characters (a-z, A-Z, and some specials)
    if (data.length === 1) {
      const code = data.charCodeAt(0);

      // Letters a-z or A-Z: Ctrl sends code & 0x1f
      if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
        return String.fromCharCode(code & 0x1f);
      }

      // Special Ctrl combinations
      // Ctrl+[ = Escape (0x1b)
      if (code === 0x5b) return '\x1b';
      // Ctrl+\ = 0x1c
      if (code === 0x5c) return '\x1c';
      // Ctrl+] = 0x1d
      if (code === 0x5d) return '\x1d';
      // Ctrl+^ = 0x1e
      if (code === 0x5e) return '\x1e';
      // Ctrl+_ = 0x1f
      if (code === 0x5f) return '\x1f';
      // Ctrl+Space or Ctrl+@ = 0x00 (NUL)
      if (code === 0x20 || code === 0x40) return '\x00';
    }
    return null;
  }

  if (modifier === 'alt') {
    // Alt sends ESC prefix followed by the character
    return '\x1b' + data;
  }

  return null;
}
