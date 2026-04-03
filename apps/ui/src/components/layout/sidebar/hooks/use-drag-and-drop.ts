import { useCallback } from 'react';
import { useSensors, useSensor, PointerSensor, type DragEndEvent } from '@dnd-kit/core';
import type { Project } from '@/lib/electron';

interface UseDragAndDropProps {
  projects: Project[];
  reorderProjects: (oldIndex: number, newIndex: number) => void;
}

export function useDragAndDrop({ projects, reorderProjects }: UseDragAndDropProps) {
  // Sensors for drag-and-drop
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5, // Small distance to start drag
      },
    })
  );

  // Handle drag end for reordering projects
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      if (over && active.id !== over.id) {
        const oldIndex = projects.findIndex((p) => p.id === active.id);
        const newIndex = projects.findIndex((p) => p.id === over.id);

        if (oldIndex !== -1 && newIndex !== -1) {
          reorderProjects(oldIndex, newIndex);
        }
      }
    },
    [projects, reorderProjects]
  );

  return {
    sensors,
    handleDragEnd,
  };
}
