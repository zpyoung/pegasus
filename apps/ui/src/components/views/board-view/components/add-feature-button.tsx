import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus, ChevronDown, Zap, FileText } from "lucide-react";
import type { FeatureTemplate } from "@pegasus/types";
import { cn } from "@/lib/utils";

interface AddFeatureButtonProps {
  /** Handler for the primary "Add Feature" action (opens full dialog) */
  onAddFeature: () => void;
  /** Handler for Quick Add submission */
  onQuickAdd: () => void;
  /** Handler for template selection */
  onTemplateSelect: (template: FeatureTemplate) => void;
  /** Global (app-level) templates */
  templates: FeatureTemplate[];
  /** Project-level templates (shown above global templates with a separator) */
  projectTemplates?: FeatureTemplate[];
  /** Whether to show as a small icon button or full button */
  compact?: boolean;
  /** Whether the button should take full width */
  fullWidth?: boolean;
  /** Additional className */
  className?: string;
  /** Test ID prefix */
  testIdPrefix?: string;
  /** Shortcut text to display (optional) */
  shortcut?: string;
}

export function AddFeatureButton({
  onAddFeature,
  onQuickAdd,
  onTemplateSelect,
  templates,
  projectTemplates,
  compact = false,
  fullWidth = false,
  className,
  testIdPrefix = "add-feature",
  shortcut,
}: AddFeatureButtonProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // Filter to only enabled templates and sort by order
  const enabledTemplates = templates
    .filter((t) => t.enabled !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  // Filter project-level templates
  const enabledProjectTemplates = (projectTemplates ?? [])
    .filter((t) => t.enabled !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const hasProjectTemplates = enabledProjectTemplates.length > 0;
  const hasGlobalTemplates = enabledTemplates.length > 0;
  const showSeparator = hasProjectTemplates && hasGlobalTemplates;
  const hasAnyTemplates = hasProjectTemplates || hasGlobalTemplates;

  const handleTemplateClick = (template: FeatureTemplate) => {
    setDropdownOpen(false);
    onTemplateSelect(template);
  };

  if (compact) {
    // Compact mode: Three small icon segments
    return (
      <div className={cn("flex", className)}>
        {/* Segment 1: Add Feature */}
        <Button
          variant="default"
          size="sm"
          className="h-6 w-6 p-0 rounded-r-none"
          onClick={onAddFeature}
          title="Add Feature"
          data-testid={`${testIdPrefix}-button`}
        >
          <Plus className="w-3.5 h-3.5" />
        </Button>
        {/* Segment 2: Quick Add */}
        <Button
          variant="default"
          size="sm"
          className="h-6 w-6 p-0 rounded-none border-l border-primary-foreground/20"
          onClick={onQuickAdd}
          title="Quick Add"
          data-testid={`${testIdPrefix}-quick-add-button`}
        >
          <Zap className="w-3 h-3" />
        </Button>
        {/* Segment 3: Templates dropdown */}
        {hasAnyTemplates && (
          <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="default"
                size="sm"
                className="h-6 w-4 p-0 rounded-l-none border-l border-primary-foreground/20"
                title="Templates"
                data-testid={`${testIdPrefix}-dropdown-trigger`}
              >
                <ChevronDown className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={4}>
              {hasProjectTemplates && (
                <>
                  {showSeparator && (
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Project
                    </DropdownMenuLabel>
                  )}
                  {enabledProjectTemplates.map((template) => (
                    <DropdownMenuItem
                      key={template.id}
                      onClick={() => handleTemplateClick(template)}
                      data-testid={`template-menu-item-${template.id}`}
                    >
                      <FileText className="w-4 h-4 mr-2" />
                      <span className="truncate max-w-[200px]">
                        {template.name}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              {showSeparator && <DropdownMenuSeparator />}
              {hasGlobalTemplates && (
                <>
                  {showSeparator && (
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Global
                    </DropdownMenuLabel>
                  )}
                  {enabledTemplates.map((template) => (
                    <DropdownMenuItem
                      key={template.id}
                      onClick={() => handleTemplateClick(template)}
                      data-testid={`template-menu-item-${template.id}`}
                    >
                      <FileText className="w-4 h-4 mr-2" />
                      <span className="truncate max-w-[200px]">
                        {template.name}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
  }

  // Full mode: Three-segment button
  return (
    <div
      className={cn("flex justify-center", fullWidth && "w-full", className)}
    >
      {/* Segment 1: Add Feature */}
      <Button
        variant="default"
        size="sm"
        className={cn("h-8 text-xs px-3 rounded-r-none", fullWidth && "flex-1")}
        onClick={onAddFeature}
        data-testid={`${testIdPrefix}-button`}
      >
        <Plus className="w-3.5 h-3.5 mr-1.5" />
        Add Feature
        {shortcut && (
          <span className="ml-auto pl-2 text-[10px] font-mono opacity-70 bg-black/20 px-1 py-0.5 rounded">
            {shortcut}
          </span>
        )}
      </Button>
      {/* Segment 2: Quick Add */}
      <Button
        variant="default"
        size="sm"
        className={cn(
          "h-8 text-xs px-2.5 rounded-none border-l border-primary-foreground/20",
          fullWidth && "flex-shrink-0",
        )}
        onClick={onQuickAdd}
        data-testid={`${testIdPrefix}-quick-add-button`}
      >
        <Zap className="w-3.5 h-3.5 mr-1" />
        Quick
      </Button>
      {/* Segment 3: Templates dropdown */}
      <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="default"
            size="sm"
            className={cn(
              "h-8 rounded-l-none border-l border-primary-foreground/20",
              hasAnyTemplates ? "px-1.5" : "w-7 p-0",
              fullWidth && "flex-shrink-0",
            )}
            aria-label="Templates"
            title="Templates"
            data-testid={`${testIdPrefix}-dropdown-trigger`}
          >
            <FileText className="w-3.5 h-3.5 mr-0.5" />
            <ChevronDown className="w-2.5 h-2.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4}>
          {hasAnyTemplates ? (
            <>
              {hasProjectTemplates && (
                <>
                  {showSeparator && (
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Project
                    </DropdownMenuLabel>
                  )}
                  {enabledProjectTemplates.map((template) => (
                    <DropdownMenuItem
                      key={template.id}
                      onClick={() => handleTemplateClick(template)}
                      data-testid={`template-menu-item-${template.id}`}
                    >
                      <FileText className="w-4 h-4 mr-2" />
                      <span className="truncate max-w-[200px]">{template.name}</span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              {showSeparator && <DropdownMenuSeparator />}
              {hasGlobalTemplates && (
                <>
                  {showSeparator && (
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Global
                    </DropdownMenuLabel>
                  )}
                  {enabledTemplates.map((template) => (
                    <DropdownMenuItem
                      key={template.id}
                      onClick={() => handleTemplateClick(template)}
                      data-testid={`template-menu-item-${template.id}`}
                    >
                      <FileText className="w-4 h-4 mr-2" />
                      <span className="truncate max-w-[200px]">{template.name}</span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </>
          ) : (
            <DropdownMenuItem disabled className="text-muted-foreground">
              No templates configured
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
