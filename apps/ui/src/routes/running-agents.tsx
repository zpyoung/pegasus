import { createFileRoute } from "@tanstack/react-router";
import { RunningAgentsView } from "@/components/views/running-agents-view";

export const Route = createFileRoute("/running-agents")({
  component: RunningAgentsView,
});
