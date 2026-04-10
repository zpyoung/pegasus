/**
 * Unit tests for shortcut-utils
 *
 * Tests:
 *  - FR-008: quickAddIdea shortcut is registered in DEFAULT_KEYBOARD_SHORTCUTS
 *  - parseShortcut correctly parses modifier+key strings
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  parseShortcut,
} from '../../../src/store/utils/shortcut-utils';

describe('DEFAULT_KEYBOARD_SHORTCUTS', () => {
  it('includes quickAddIdea shortcut (FR-008)', () => {
    expect(DEFAULT_KEYBOARD_SHORTCUTS).toHaveProperty('quickAddIdea');
  });

  it('quickAddIdea shortcut is Shift+I', () => {
    expect(DEFAULT_KEYBOARD_SHORTCUTS.quickAddIdea).toBe('Shift+I');
  });

  it('does not change the existing ideation navigation shortcut', () => {
    // The nav shortcut 'I' must remain unchanged (Codex MEDIUM finding resolution)
    expect(DEFAULT_KEYBOARD_SHORTCUTS.ideation).toBe('I');
  });

  it('quickAddIdea and ideation shortcuts are different (no collision)', () => {
    expect(DEFAULT_KEYBOARD_SHORTCUTS.quickAddIdea).not.toBe(DEFAULT_KEYBOARD_SHORTCUTS.ideation);
  });
});

describe('parseShortcut', () => {
  it('parses Shift+I into { key: "I", shift: true }', () => {
    const parsed = parseShortcut('Shift+I');
    expect(parsed.key).toBe('I');
    expect(parsed.shift).toBe(true);
    expect(parsed.cmdCtrl).toBeUndefined();
    expect(parsed.alt).toBeUndefined();
  });

  it('parses a plain letter shortcut with no modifiers', () => {
    const parsed = parseShortcut('I');
    expect(parsed.key).toBe('I');
    expect(parsed.shift).toBeUndefined();
    expect(parsed.cmdCtrl).toBeUndefined();
  });

  it('returns empty key for null/undefined input', () => {
    expect(parseShortcut(null).key).toBe('');
    expect(parseShortcut(undefined).key).toBe('');
  });
});
