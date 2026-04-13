/**
 * Project Template Mutation Hooks
 *
 * React Query mutations for managing project-level feature templates (CRUD).
 * Feature templates are pre-configured task prompts stored in project settings
 * that allow users to quickly create features with pre-written prompts.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getElectronAPI } from '@/lib/electron';
import { queryKeys } from '@/lib/query-keys';
import { toast } from 'sonner';
import type { FeatureTemplate } from '@pegasus/types';

// ============================================================================
// Add Project Template
// ============================================================================

/**
 * Add a new feature template to project settings
 *
 * @param projectPath - Path to the project
 * @returns Mutation for adding a project-level feature template
 *
 * @example
 * ```tsx
 * const mutation = useAddProjectTemplate(projectPath);
 * mutation.mutate({
 *   id: 'my-template',
 *   name: 'My Template',
 *   prompt: 'Do something useful...',
 *   enabled: true,
 * });
 * ```
 */
export function useAddProjectTemplate(projectPath: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (template: FeatureTemplate) => {
      const api = getElectronAPI();
      if (!api.settings) {
        throw new Error('Settings API not available');
      }

      // Fetch current project settings to get existing templates
      const current = await api.settings.getProject(projectPath);
      if (!current.success) {
        throw new Error(current.error || 'Failed to fetch project settings');
      }

      const currentSettings = current.settings ?? {};
      const existingTemplates = (currentSettings.featureTemplates as FeatureTemplate[]) ?? [];

      // Append the new template
      const updated = [...existingTemplates, template];

      const result = await api.settings.updateProject(projectPath, {
        featureTemplates: updated,
      });
      if (!result.success) {
        throw new Error(result.error || 'Failed to add project template');
      }

      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.project(projectPath) });
      toast.success('Template added');
    },
    onError: (error: Error) => {
      toast.error('Failed to add template', { description: error.message });
    },
  });
}

// ============================================================================
// Update Project Template
// ============================================================================

interface UpdateProjectTemplateVariables {
  id: string;
  updates: Partial<Omit<FeatureTemplate, 'id'>>;
}

/**
 * Update an existing feature template in project settings
 *
 * @param projectPath - Path to the project
 * @returns Mutation for updating a project-level feature template
 *
 * @example
 * ```tsx
 * const mutation = useUpdateProjectTemplate(projectPath);
 * mutation.mutate({ id: 'my-template', updates: { name: 'Updated Name' } });
 * ```
 */
export function useUpdateProjectTemplate(projectPath: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: UpdateProjectTemplateVariables) => {
      const api = getElectronAPI();
      if (!api.settings) {
        throw new Error('Settings API not available');
      }

      // Fetch current project settings
      const current = await api.settings.getProject(projectPath);
      if (!current.success) {
        throw new Error(current.error || 'Failed to fetch project settings');
      }

      const currentSettings = current.settings ?? {};
      const existingTemplates = (currentSettings.featureTemplates as FeatureTemplate[]) ?? [];

      const updated = existingTemplates.map((t) => (t.id === id ? { ...t, ...updates } : t));

      const result = await api.settings.updateProject(projectPath, {
        featureTemplates: updated,
      });
      if (!result.success) {
        throw new Error(result.error || 'Failed to update project template');
      }

      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.project(projectPath) });
      toast.success('Template updated');
    },
    onError: (error: Error) => {
      toast.error('Failed to update template', { description: error.message });
    },
  });
}

// ============================================================================
// Delete Project Template
// ============================================================================

/**
 * Delete a feature template from project settings
 *
 * Built-in templates (isBuiltIn: true) cannot be deleted and will throw an error.
 *
 * @param projectPath - Path to the project
 * @returns Mutation for deleting a project-level feature template
 *
 * @example
 * ```tsx
 * const mutation = useDeleteProjectTemplate(projectPath);
 * mutation.mutate('my-template-id');
 * ```
 */
export function useDeleteProjectTemplate(projectPath: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (templateId: string) => {
      const api = getElectronAPI();
      if (!api.settings) {
        throw new Error('Settings API not available');
      }

      // Fetch current project settings
      const current = await api.settings.getProject(projectPath);
      if (!current.success) {
        throw new Error(current.error || 'Failed to fetch project settings');
      }

      const currentSettings = current.settings ?? {};
      const existingTemplates = (currentSettings.featureTemplates as FeatureTemplate[]) ?? [];

      const target = existingTemplates.find((t) => t.id === templateId);
      if (target?.isBuiltIn) {
        throw new Error('Built-in templates cannot be deleted');
      }

      const updated = existingTemplates.filter((t) => t.id !== templateId);

      const result = await api.settings.updateProject(projectPath, {
        featureTemplates: updated,
      });
      if (!result.success) {
        throw new Error(result.error || 'Failed to delete project template');
      }

      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.project(projectPath) });
      toast.success('Template deleted');
    },
    onError: (error: Error) => {
      toast.error('Failed to delete template', { description: error.message });
    },
  });
}

// ============================================================================
// Reorder Project Templates
// ============================================================================

/**
 * Reorder feature templates in project settings
 *
 * Accepts an ordered array of template IDs and updates the `order` field on
 * each template accordingly.
 *
 * @param projectPath - Path to the project
 * @returns Mutation for reordering project-level feature templates
 *
 * @example
 * ```tsx
 * const mutation = useReorderProjectTemplates(projectPath);
 * mutation.mutate(['template-b', 'template-a', 'template-c']);
 * ```
 */
export function useReorderProjectTemplates(projectPath: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (orderedIds: string[]) => {
      const api = getElectronAPI();
      if (!api.settings) {
        throw new Error('Settings API not available');
      }

      // Fetch current project settings
      const current = await api.settings.getProject(projectPath);
      if (!current.success) {
        throw new Error(current.error || 'Failed to fetch project settings');
      }

      const currentSettings = current.settings ?? {};
      const existingTemplates = (currentSettings.featureTemplates as FeatureTemplate[]) ?? [];

      const templateMap = new Map(existingTemplates.map((t) => [t.id, t]));
      const reordered: FeatureTemplate[] = [];

      orderedIds.forEach((id, index) => {
        const template = templateMap.get(id);
        if (template) {
          reordered.push({ ...template, order: index });
        }
      });

      // Include any templates not present in orderedIds at the end
      existingTemplates.forEach((t) => {
        if (!orderedIds.includes(t.id)) {
          reordered.push(t);
        }
      });

      const result = await api.settings.updateProject(projectPath, {
        featureTemplates: reordered,
      });
      if (!result.success) {
        throw new Error(result.error || 'Failed to reorder project templates');
      }

      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.project(projectPath) });
    },
    onError: (error: Error) => {
      toast.error('Failed to reorder templates', { description: error.message });
    },
  });
}
