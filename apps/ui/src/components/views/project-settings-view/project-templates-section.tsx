/**
 * ProjectTemplatesSection
 *
 * Wraps the global TemplatesSection component with project-level data and
 * mutation handlers, allowing feature templates to be managed per-project
 * via project settings.
 */

import type { Project } from '@/lib/electron';
import type { FeatureTemplate } from '@pegasus/types';
import { TemplatesSection } from '../settings-view/templates/templates-section';
import { useProjectSettings } from '@/hooks/queries/use-settings';
import {
  useAddProjectTemplate,
  useUpdateProjectTemplate,
  useDeleteProjectTemplate,
  useReorderProjectTemplates,
} from '@/hooks/mutations/use-project-template-mutations';

interface ProjectTemplatesSectionProps {
  project: Project;
}

/**
 * Renders the feature templates management section for a specific project.
 *
 * Project templates are stored in project-level settings and take precedence
 * over global templates. If no project templates are configured yet this
 * section starts with an empty list so users can create project-specific ones.
 */
export function ProjectTemplatesSection({ project }: ProjectTemplatesSectionProps) {
  const { data: projectSettings } = useProjectSettings(project.path);

  const addMutation = useAddProjectTemplate(project.path);
  const updateMutation = useUpdateProjectTemplate(project.path);
  const deleteMutation = useDeleteProjectTemplate(project.path);
  const reorderMutation = useReorderProjectTemplates(project.path);

  // Project-level templates stored in project settings (may be undefined before first save)
  const templates: FeatureTemplate[] = (projectSettings?.featureTemplates as FeatureTemplate[]) ?? [];

  const handleAddTemplate = async (template: FeatureTemplate) => {
    await addMutation.mutateAsync(template);
  };

  const handleUpdateTemplate = async (id: string, updates: Partial<FeatureTemplate>) => {
    await updateMutation.mutateAsync({ id, updates });
  };

  const handleDeleteTemplate = async (id: string) => {
    await deleteMutation.mutateAsync(id);
  };

  const handleReorderTemplates = async (templateIds: string[]) => {
    await reorderMutation.mutateAsync(templateIds);
  };

  return (
    <TemplatesSection
      templates={templates}
      onAddTemplate={handleAddTemplate}
      onUpdateTemplate={handleUpdateTemplate}
      onDeleteTemplate={handleDeleteTemplate}
      onReorderTemplates={handleReorderTemplates}
    />
  );
}
