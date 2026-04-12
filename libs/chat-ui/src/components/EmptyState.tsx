import type { EmptyStateProps } from "../types.js";

export function EmptyState({ children }: EmptyStateProps) {
  if (!children) return null;
  return (
    <div className="flex flex-col items-center justify-center h-full p-6 text-center text-muted-foreground">
      {children}
    </div>
  );
}
