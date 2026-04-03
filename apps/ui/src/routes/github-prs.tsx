import { createFileRoute } from '@tanstack/react-router';
import { GitHubPRsView } from '@/components/views/github-prs-view';

export const Route = createFileRoute('/github-prs')({
  component: GitHubPRsView,
});
