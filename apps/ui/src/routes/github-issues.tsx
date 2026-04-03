import { createFileRoute } from '@tanstack/react-router';
import { GitHubIssuesView } from '@/components/views/github-issues-view';

export const Route = createFileRoute('/github-issues')({
  component: GitHubIssuesView,
});
