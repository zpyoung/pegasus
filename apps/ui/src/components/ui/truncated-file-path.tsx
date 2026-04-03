import { cn } from '@/lib/utils';

interface TruncatedFilePathProps {
  /** The full file path to display */
  path: string;
  /** Additional CSS class names */
  className?: string;
}

/**
 * Renders a file path with middle truncation.
 *
 * When the path is too long to fit in its container, the middle portion
 * (directory path) is truncated with an ellipsis while preserving both
 * the beginning of the path and the filename at the end.
 *
 * Example: "src/components/...dialog.tsx" instead of "src/components/views/boa..."
 */
export function TruncatedFilePath({ path, className }: TruncatedFilePathProps) {
  const lastSlash = path.lastIndexOf('/');

  // If there's no directory component, just render with normal truncation
  if (lastSlash === -1) {
    return (
      <span className={cn('truncate', className)} title={path}>
        {path}
      </span>
    );
  }

  const dirPart = path.slice(0, lastSlash + 1); // includes trailing slash
  const filePart = path.slice(lastSlash + 1);

  return (
    <span className={cn('flex min-w-0', className)} title={path}>
      <span className="truncate shrink">{dirPart}</span>
      <span className="shrink-0 whitespace-nowrap">{filePart}</span>
    </span>
  );
}
