import { createFileRoute } from "@tanstack/react-router";
import { ContextView } from "@/components/views/context-view";

export const Route = createFileRoute("/context")({
  component: ContextView,
});
