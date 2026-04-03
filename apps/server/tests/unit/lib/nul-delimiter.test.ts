// Automated tests for NUL character behavior in git commit parsing

import { describe, it, expect } from 'vitest';

describe('NUL character behavior', () => {
  // Create a string with NUL characters
  const str1 =
    'abc123\x00abc1\x00John Doe\x00john@example.com\x002023-01-01T12:00:00Z\x00Initial commit\x00This is a normal commit body\x00';

  describe('split on NUL character', () => {
    const parts = str1.split('\0');

    it('should produce the expected number of parts', () => {
      // 7 fields + 1 trailing empty string from the trailing \x00
      expect(parts.length).toBe(8);
    });

    it('should contain the expected part values', () => {
      expect(parts[0]).toBe('abc123');
      expect(parts[1]).toBe('abc1');
      expect(parts[2]).toBe('John Doe');
      expect(parts[3]).toBe('john@example.com');
      expect(parts[4]).toBe('2023-01-01T12:00:00Z');
      expect(parts[5]).toBe('Initial commit');
      expect(parts[6]).toBe('This is a normal commit body');
      expect(parts[7]).toBe('');
    });

    it('should have correct lengths for each part', () => {
      expect(parts[0].length).toBe(6); // 'abc123'
      expect(parts[1].length).toBe(4); // 'abc1'
      expect(parts[2].length).toBe(8); // 'John Doe'
      expect(parts[3].length).toBe(16); // 'john@example.com'
      expect(parts[4].length).toBe(20); // '2023-01-01T12:00:00Z'
      expect(parts[5].length).toBe(14); // 'Initial commit'
      expect(parts[6].length).toBe(28); // 'This is a normal commit body'
      expect(parts[7].length).toBe(0); // trailing empty
    });
  });

  describe('git format split and filter', () => {
    const gitFormat = `abc123\x00abc1\x00John Doe\x00john@example.com\x002023-01-01T12:00:00Z\x00Initial commit\x00Body text here\x00def456\x00def4\x00Jane Smith\x00jane@example.com\x002023-01-02T12:00:00Z\x00Second commit\x00Body with ---END--- text\x00`;

    const gitParts = gitFormat.split('\0').filter((block) => block.trim());

    it('should produce the expected number of non-empty parts after filtering', () => {
      // 14 non-empty field strings (7 fields per commit × 2 commits); trailing empty is filtered out
      expect(gitParts.length).toBe(14);
    });

    it('should contain correct field values for the first commit', () => {
      const fields = gitParts.slice(0, 7);
      expect(fields.length).toBe(7);
      expect(fields[0]).toBe('abc123'); // hash
      expect(fields[1]).toBe('abc1'); // shortHash
      expect(fields[2]).toBe('John Doe'); // author
      expect(fields[3]).toBe('john@example.com'); // authorEmail
      expect(fields[4]).toBe('2023-01-01T12:00:00Z'); // date
      expect(fields[5]).toBe('Initial commit'); // subject
      expect(fields[6]).toBe('Body text here'); // body
    });

    it('should contain correct field values for the second commit', () => {
      const fields = gitParts.slice(7, 14);
      expect(fields.length).toBe(7);
      expect(fields[0]).toBe('def456'); // hash
      expect(fields[1]).toBe('def4'); // shortHash
      expect(fields[2]).toBe('Jane Smith'); // author
      expect(fields[3]).toBe('jane@example.com'); // authorEmail
      expect(fields[4]).toBe('2023-01-02T12:00:00Z'); // date
      expect(fields[5]).toBe('Second commit'); // subject
      expect(fields[6]).toBe('Body with ---END--- text'); // body (---END--- handled correctly)
    });

    it('each part should have the expected number of newline-delimited fields', () => {
      // Each gitPart is a single field value (no internal newlines), so split('\n') yields 1 field
      gitParts.forEach((block) => {
        const fields = block.split('\n');
        expect(fields.length).toBe(1);
      });
    });
  });
});
