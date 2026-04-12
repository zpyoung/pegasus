import { createFileRoute } from "@tanstack/react-router";
import { WikiView } from "@/components/views/wiki-view";

export const Route = createFileRoute("/wiki")({
  component: WikiView,
});
