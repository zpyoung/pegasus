import { useState } from "react";
import {
  Sparkles,
  Lightbulb,
  Zap,
  Palette,
  Code,
  TrendingUp,
  Cpu,
  Shield,
  Gauge,
  Accessibility,
  BarChart,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useGuidedPrompts } from "@/hooks/use-guided-prompts";
import { useGenerateIdeationSuggestions } from "@/hooks/mutations/use-ideation-mutations";
import { useIdeationStore } from "@/store/ideation-store";

/** Maps the icon string returned by the server (PromptCategory.icon) to a Lucide component. */
export const ICON_MAP: Record<string, LucideIcon> = {
  Zap,
  Palette,
  Code,
  TrendingUp,
  Cpu,
  Shield,
  Gauge,
  Accessibility,
  BarChart,
};

interface PromptCommandPopoverProps {
  projectPath: string;
}

export function PromptCommandPopover({ projectPath }: PromptCommandPopoverProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const addGenerationJob = useIdeationStore((s) => s.addGenerationJob);
  const { categories, prompts, isLoading } = useGuidedPrompts();
  const generateMutation = useGenerateIdeationSuggestions(projectPath);

  const query = search.toLowerCase();

  const filteredCategories = categories
    .map((cat) => ({
      ...cat,
      prompts: prompts.filter(
        (p) =>
          p.category === cat.id &&
          (query === "" ||
            p.title.toLowerCase().includes(query) ||
            p.description.toLowerCase().includes(query)),
      ),
    }))
    .filter((cat) => cat.prompts.length > 0);

  function handleSelect(promptId: string) {
    const prompt = prompts.find((p) => p.id === promptId);
    if (!prompt || !projectPath) return;

    const jobId = addGenerationJob(projectPath, prompt);
    generateMutation.mutate({
      promptId: prompt.id,
      category: prompt.category,
      jobId,
      promptTitle: prompt.title,
    });
    setOpen(false);
    setSearch("");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Sparkles className="h-4 w-4" />
          Generate Ideas
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search prompts…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>
              {isLoading ? "Loading prompts…" : "No prompts found."}
            </CommandEmpty>
            {filteredCategories.map((cat) => {
              const Icon = ICON_MAP[cat.icon] ?? Lightbulb;
              return (
                <CommandGroup
                  key={cat.id}
                  heading={
                    <span className="flex items-center gap-1.5">
                      <Icon className="h-3.5 w-3.5" />
                      {cat.name}
                    </span>
                  }
                >
                  {cat.prompts.map((prompt) => (
                    <CommandItem
                      key={prompt.id}
                      value={prompt.id}
                      onSelect={handleSelect}
                    >
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="truncate">{prompt.title}</span>
                        <span className="text-xs text-muted-foreground truncate">
                          {prompt.description}
                        </span>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
