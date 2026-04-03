import { describe, it, expect } from 'vitest';
import { parseGitLogOutput } from '../../../src/lib/git-log-parser.js';

// Mock data: fields within each commit are newline-separated,
// commits are NUL-separated (matching the parser contract).
const mockGitOutput = [
  'a1b2c3d4e5f67890abcd1234567890abcd1234\na1b2c3\nJohn Doe\njohn@example.com\n2023-01-01T12:00:00Z\nInitial commit\nThis is the commit body',
  'e5f6g7h8i9j0klmnoprstuv\ne5f6g7\nJane Smith\njane@example.com\n2023-01-02T12:00:00Z\nFix bug\nFixed the bug with ---END--- in the message',
  'q1w2e3r4t5y6u7i8o9p0asdfghjkl\nq1w2e3\nBob Johnson\nbob@example.com\n2023-01-03T12:00:00Z\nAnother commit\nEmpty body',
].join('\0');

// Mock data where commit bodies contain ---END--- markers
const mockOutputWithEndMarker = [
  'a1b2c3d4e5f67890abcd1234567890abcd1234\na1b2c3\nJohn Doe\njohn@example.com\n2023-01-01T12:00:00Z\nInitial commit\nThis is the commit body\n---END--- is in this message',
  'e5f6g7h8i9j0klmnoprstuv\ne5f6g7\nJane Smith\njane@example.com\n2023-01-02T12:00:00Z\nFix bug\nFixed the bug with ---END--- in the message',
  'q1w2e3r4t5y6u7i8o9p0asdfghjkl\nq1w2e3\nBob Johnson\nbob@example.com\n2023-01-03T12:00:00Z\nAnother commit\nEmpty body',
].join('\0');

// Single-commit mock: fields newline-separated, no trailing NUL needed
const singleCommitOutput =
  'a1b2c3d4e5f67890abcd1234567890abcd1234\na1b2c3\nJohn Doe\njohn@example.com\n2023-01-01T12:00:00Z\nSingle commit\nSingle commit body';

describe('parseGitLogOutput', () => {
  describe('normal parsing (three commits)', () => {
    it('returns the correct number of commits', () => {
      const commits = parseGitLogOutput(mockGitOutput);
      expect(commits.length).toBe(3);
    });

    it('parses the first commit fields correctly', () => {
      const commits = parseGitLogOutput(mockGitOutput);
      expect(commits[0].hash).toBe('a1b2c3d4e5f67890abcd1234567890abcd1234');
      expect(commits[0].shortHash).toBe('a1b2c3');
      expect(commits[0].author).toBe('John Doe');
      expect(commits[0].authorEmail).toBe('john@example.com');
      expect(commits[0].date).toBe('2023-01-01T12:00:00Z');
      expect(commits[0].subject).toBe('Initial commit');
      expect(commits[0].body).toBe('This is the commit body');
    });

    it('parses the second commit fields correctly', () => {
      const commits = parseGitLogOutput(mockGitOutput);
      expect(commits[1].hash).toBe('e5f6g7h8i9j0klmnoprstuv');
      expect(commits[1].shortHash).toBe('e5f6g7');
      expect(commits[1].author).toBe('Jane Smith');
      expect(commits[1].subject).toBe('Fix bug');
      expect(commits[1].body).toMatch(/---END---/);
    });

    it('parses the third commit fields correctly', () => {
      const commits = parseGitLogOutput(mockGitOutput);
      expect(commits[2].hash).toBe('q1w2e3r4t5y6u7i8o9p0asdfghjkl');
      expect(commits[2].shortHash).toBe('q1w2e3');
      expect(commits[2].author).toBe('Bob Johnson');
      expect(commits[2].subject).toBe('Another commit');
      expect(commits[2].body).toBe('Empty body');
    });
  });

  describe('parsing with ---END--- in commit messages', () => {
    it('returns the correct number of commits', () => {
      const commits = parseGitLogOutput(mockOutputWithEndMarker);
      expect(commits.length).toBe(3);
    });

    it('preserves ---END--- text in the body of the first commit', () => {
      const commits = parseGitLogOutput(mockOutputWithEndMarker);
      expect(commits[0].subject).toBe('Initial commit');
      expect(commits[0].body).toMatch(/---END---/);
    });

    it('preserves ---END--- text in the body of the second commit', () => {
      const commits = parseGitLogOutput(mockOutputWithEndMarker);
      expect(commits[1].subject).toBe('Fix bug');
      expect(commits[1].body).toMatch(/---END---/);
    });

    it('parses the third commit without ---END--- interference', () => {
      const commits = parseGitLogOutput(mockOutputWithEndMarker);
      expect(commits[2].subject).toBe('Another commit');
      expect(commits[2].body).toBe('Empty body');
    });
  });

  describe('empty output', () => {
    it('returns an empty array for an empty string', () => {
      const commits = parseGitLogOutput('');
      expect(commits).toEqual([]);
      expect(commits.length).toBe(0);
    });
  });

  describe('single-commit output', () => {
    it('returns exactly one commit', () => {
      const commits = parseGitLogOutput(singleCommitOutput);
      expect(commits.length).toBe(1);
    });

    it('parses the single commit fields correctly', () => {
      const commits = parseGitLogOutput(singleCommitOutput);
      expect(commits[0].hash).toBe('a1b2c3d4e5f67890abcd1234567890abcd1234');
      expect(commits[0].shortHash).toBe('a1b2c3');
      expect(commits[0].author).toBe('John Doe');
      expect(commits[0].authorEmail).toBe('john@example.com');
      expect(commits[0].date).toBe('2023-01-01T12:00:00Z');
      expect(commits[0].subject).toBe('Single commit');
      expect(commits[0].body).toBe('Single commit body');
    });
  });

  describe('multi-line commit body', () => {
    // Test vector from test-proper-nul-format.js: commit with a 3-line body
    const multiLineBodyOutput =
      [
        'abc123\nabc1\nJohn Doe\njohn@example.com\n2023-01-01T12:00:00Z\nInitial commit\nThis is a normal commit body',
        'def456\ndef4\nJane Smith\njane@example.com\n2023-01-02T12:00:00Z\nFix bug\nFixed the bug with ---END--- in this message',
        'ghi789\nghi7\nBob Johnson\nbob@example.com\n2023-01-03T12:00:00Z\nAnother commit\nThis body has multiple lines\nSecond line\nThird line',
      ].join('\0') + '\0';

    it('returns 3 commits', () => {
      const commits = parseGitLogOutput(multiLineBodyOutput);
      expect(commits.length).toBe(3);
    });

    it('parses the first commit correctly', () => {
      const commits = parseGitLogOutput(multiLineBodyOutput);
      expect(commits[0].hash).toBe('abc123');
      expect(commits[0].shortHash).toBe('abc1');
      expect(commits[0].author).toBe('John Doe');
      expect(commits[0].authorEmail).toBe('john@example.com');
      expect(commits[0].date).toBe('2023-01-01T12:00:00Z');
      expect(commits[0].subject).toBe('Initial commit');
      expect(commits[0].body).toBe('This is a normal commit body');
    });

    it('parses the second commit with ---END--- in body correctly', () => {
      const commits = parseGitLogOutput(multiLineBodyOutput);
      expect(commits[1].hash).toBe('def456');
      expect(commits[1].shortHash).toBe('def4');
      expect(commits[1].author).toBe('Jane Smith');
      expect(commits[1].subject).toBe('Fix bug');
      expect(commits[1].body).toContain('---END---');
    });

    it('parses the third commit with a multi-line body correctly', () => {
      const commits = parseGitLogOutput(multiLineBodyOutput);
      expect(commits[2].hash).toBe('ghi789');
      expect(commits[2].shortHash).toBe('ghi7');
      expect(commits[2].author).toBe('Bob Johnson');
      expect(commits[2].subject).toBe('Another commit');
      expect(commits[2].body).toBe('This body has multiple lines\nSecond line\nThird line');
    });
  });

  describe('commit with empty body (trailing blank lines after subject)', () => {
    // Test vector from test-proper-nul-format.js: empty body commit
    const emptyBodyOutput =
      'empty123\nempty1\nAlice Brown\nalice@example.com\n2023-01-04T12:00:00Z\nEmpty body commit\n\n\0';

    it('returns 1 commit', () => {
      const commits = parseGitLogOutput(emptyBodyOutput);
      expect(commits.length).toBe(1);
    });

    it('parses the commit subject correctly', () => {
      const commits = parseGitLogOutput(emptyBodyOutput);
      expect(commits[0].hash).toBe('empty123');
      expect(commits[0].shortHash).toBe('empty1');
      expect(commits[0].author).toBe('Alice Brown');
      expect(commits[0].subject).toBe('Empty body commit');
    });

    it('produces an empty body string when only blank lines follow the subject', () => {
      const commits = parseGitLogOutput(emptyBodyOutput);
      expect(commits[0].body).toBe('');
    });
  });

  describe('leading empty lines in a commit block', () => {
    // Blocks that start with blank lines before the hash field
    const outputWithLeadingBlanks =
      '\n\nabc123\nabc1\nJohn Doe\njohn@example.com\n2023-01-01T12:00:00Z\nSubject here\nBody here';

    it('returns 1 commit despite leading blank lines', () => {
      const commits = parseGitLogOutput(outputWithLeadingBlanks);
      expect(commits.length).toBe(1);
    });

    it('parses the commit fields correctly when block has leading empty lines', () => {
      const commits = parseGitLogOutput(outputWithLeadingBlanks);
      expect(commits[0].hash).toBe('abc123');
      expect(commits[0].subject).toBe('Subject here');
      expect(commits[0].body).toBe('Body here');
    });
  });
});
