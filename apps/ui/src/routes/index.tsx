import { createFileRoute } from "@tanstack/react-router";
import { WelcomeView } from "@/components/views/welcome-view";

export const Route = createFileRoute("/")({
  component: WelcomeView,
});
