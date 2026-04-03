import { createLazyFileRoute } from '@tanstack/react-router';
import { GraphViewPage } from '@/components/views/graph-view-page';

export const Route = createLazyFileRoute('/graph')({
  component: GraphViewPage,
});
