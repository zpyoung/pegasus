import { createFileRoute } from "@tanstack/react-router";
import { SetupView } from "@/components/views/setup-view";

export const Route = createFileRoute("/setup")({
  component: SetupView,
});
