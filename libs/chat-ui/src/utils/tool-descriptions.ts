/**
 * Maps tool name + input to a human-readable summary string.
 */
export function getToolDescription(name: string, input?: string): string {
  if (!input) return name;

  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;

    switch (name) {
      case 'Read': {
        const paths = parsed['paths'] ?? parsed['file_path'] ?? parsed['path'];
        if (Array.isArray(paths)) return `Read ${paths.length} file${paths.length !== 1 ? 's' : ''}`;
        if (typeof paths === 'string') return `Read ${truncatePath(paths)}`;
        return 'Read file';
      }
      case 'Grep': {
        const pattern = parsed['pattern'];
        if (typeof pattern === 'string') return `Searched for '${truncate(pattern, 30)}'`;
        return 'Grep search';
      }
      case 'Glob': {
        const p = parsed['pattern'];
        if (typeof p === 'string') return `Glob '${truncate(p, 30)}'`;
        return 'Glob search';
      }
      default:
        return name;
    }
  } catch {
    return name;
  }
}

function truncatePath(p: string): string {
  const parts = p.split('/');
  return parts.length > 3 ? `.../${parts.slice(-2).join('/')}` : p;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
