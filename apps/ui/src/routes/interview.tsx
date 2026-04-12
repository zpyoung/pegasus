import { createFileRoute } from "@tanstack/react-router";
import { InterviewView } from "@/components/views/interview-view";

export const Route = createFileRoute("/interview")({
  component: InterviewView,
});
