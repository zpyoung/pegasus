import { createFileRoute } from '@tanstack/react-router';

// Component is lazy-loaded via spec.lazy.tsx for code splitting
export const Route = createFileRoute('/spec')({});
