import { createFileRoute } from "@tanstack/react-router";
import { AgentView } from "@/components/views/agent-view";

export const Route = createFileRoute("/agent")({
  component: AgentView,
});
