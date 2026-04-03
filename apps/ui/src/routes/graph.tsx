import { createFileRoute } from '@tanstack/react-router';

// Component is lazy-loaded via graph.lazy.tsx for code splitting
export const Route = createFileRoute('/graph')({});
