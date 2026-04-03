import { createLazyFileRoute } from '@tanstack/react-router';
import { SpecView } from '@/components/views/spec-view';

export const Route = createLazyFileRoute('/spec')({
  component: SpecView,
});
