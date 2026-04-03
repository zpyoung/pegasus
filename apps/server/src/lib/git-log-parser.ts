export interface CommitFields {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  body: string;
}

export function parseGitLogOutput(output: string): CommitFields[] {
  const commits: CommitFields[] = [];

  // Split by NUL character to separate commits
  const commitBlocks = output.split('\0').filter((block) => block.trim());

  for (const block of commitBlocks) {
    const allLines = block.split('\n');

    // Skip leading empty lines that may appear at block boundaries
    let startIndex = 0;
    while (startIndex < allLines.length && allLines[startIndex].trim() === '') {
      startIndex++;
    }
    const fields = allLines.slice(startIndex);

    // Validate we have all expected fields (at least hash, shortHash, author, authorEmail, date, subject)
    if (fields.length < 6) {
      continue; // Skip malformed blocks
    }

    const commit: CommitFields = {
      hash: fields[0].trim(),
      shortHash: fields[1].trim(),
      author: fields[2].trim(),
      authorEmail: fields[3].trim(),
      date: fields[4].trim(),
      subject: fields[5].trim(),
      body: fields.slice(6).join('\n').trim(),
    };

    commits.push(commit);
  }

  return commits;
}

/**
 * Creates a commit object from parsed fields, matching the expected API response format
 */
export function createCommitFromFields(fields: CommitFields, files?: string[]) {
  return {
    hash: fields.hash,
    shortHash: fields.shortHash,
    author: fields.author,
    authorEmail: fields.authorEmail,
    date: fields.date,
    subject: fields.subject,
    body: fields.body,
    files: files || [],
  };
}
