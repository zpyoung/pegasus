/**
 * IdeaCard — Pure presentation card for a single Idea.
 * Co-located with IdeaEditModal (small enough to share file).
 */

import React, { memo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { GripVertical, ArrowUpRight, Trash2, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { Idea, UpdateIdeaInput } from '@pegasus/types';

// ============================================================================
// Helpers
// ============================================================================

function getCardBorderStyle(enabled: boolean, opacity: number): React.CSSProperties {
  if (!enabled) {
    return { borderWidth: '0px', borderColor: 'transparent' };
  }
  if (opacity !== 100) {
    return {
      borderWidth: '1px',
      borderColor: `color-mix(in oklch, var(--border) ${opacity}%, transparent)`,
    };
  }
  return {};
}

// ============================================================================
// IdeaEditModal
// ============================================================================

interface IdeaEditModalProps {
  idea: Idea;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (updates: UpdateIdeaInput) => void;
  isSaving: boolean;
}

function IdeaEditModal({ idea, open, onOpenChange, onSave, isSaving }: IdeaEditModalProps) {
  const [title, setTitle] = useState(idea.title);
  const [description, setDescription] = useState(idea.description);
  const [notes, setNotes] = useState(idea.notes ?? '');
  const [userStories, setUserStories] = useState<string[]>(idea.userStories ?? []);
  const [newStory, setNewStory] = useState('');

  const isDirty =
    title !== idea.title ||
    description !== idea.description ||
    notes !== (idea.notes ?? '') ||
    JSON.stringify(userStories) !== JSON.stringify(idea.userStories ?? []);

  const handleAddStory = () => {
    if (!newStory.trim()) return;
    setUserStories((prev) => [...prev, newStory.trim()]);
    setNewStory('');
  };

  const handleRemoveStory = (index: number) => {
    setUserStories((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = () => {
    if (!title.trim()) return;
    onSave({ title: title.trim(), description, notes: notes || undefined, userStories });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Edit Idea</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">Title</label>
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What's the idea?"
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">Description</label>
            <textarea
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the idea..."
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">Notes</label>
            <textarea
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any additional notes..."
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">User Stories</label>
            {userStories.map((story, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="flex-1 text-sm text-muted-foreground">{story}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={() => handleRemoveStory(i)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
            <div className="flex gap-2">
              <input
                className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={newStory}
                onChange={(e) => setNewStory(e.target.value)}
                placeholder="As a user, I want..."
                onKeyDown={(e) => e.key === 'Enter' && handleAddStory()}
              />
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={handleAddStory}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!isDirty || !title.trim() || isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// IdeaCard
// ============================================================================

interface IdeaCardProps {
  idea: Idea;
  onEdit: (idea: Idea, updates: UpdateIdeaInput) => void;
  onPromote: (idea: Idea) => void;
  onDelete: (idea: Idea) => void;
  isSaving: boolean;
  opacity?: number;
  glassmorphism?: boolean;
  cardBorderEnabled?: boolean;
  cardBorderOpacity?: number;
}

const STATUS_COLORS: Record<string, string> = {
  raw: 'bg-muted-foreground/20 text-muted-foreground',
  refined: 'bg-blue-500/20 text-blue-400',
  ready: 'bg-emerald-500/20 text-emerald-400',
  archived: 'bg-muted',
};

export const IdeaCard = memo(function IdeaCard({
  idea,
  onEdit,
  onPromote,
  onDelete,
  isSaving,
  opacity = 100,
  glassmorphism = false,
  cardBorderEnabled = true,
  cardBorderOpacity = 100,
}: IdeaCardProps) {
  const [editOpen, setEditOpen] = useState(false);

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: idea.id,
  });

  const dndStyle = {
    opacity: isDragging ? 0.5 : undefined,
  };

  const cardBorderStyle = getCardBorderStyle(cardBorderEnabled, cardBorderOpacity);

  const handleSave = (updates: UpdateIdeaInput) => {
    onEdit(idea, updates);
    setEditOpen(false);
  };

  return (
    <>
      <div ref={setNodeRef} style={dndStyle}>
        <Card
          style={cardBorderStyle}
          className={cn(
            'group relative rounded-xl text-sm cursor-pointer',
            'transition-all duration-200 ease-out',
            'hover:-translate-y-0.5 hover:shadow-md hover:shadow-black/10',
            !cardBorderEnabled && 'border-transparent',
            isDragging && 'shadow-lg'
          )}
          onClick={() => setEditOpen(true)}
          data-testid={`idea-card-${idea.id}`}
        >
          {/* Background overlay with opacity */}
          <div
            className={cn(
              'absolute inset-0 rounded-xl bg-card -z-10',
              glassmorphism && 'backdrop-blur-sm'
            )}
            style={{ opacity: opacity / 100 }}
          />

          {/* Drag handle */}
          <div
            className="absolute top-2 left-2 opacity-0 group-hover:opacity-40 cursor-grab active:cursor-grabbing touch-none"
            {...attributes}
            {...listeners}
            onClick={(e) => e.stopPropagation()}
          >
            <GripVertical className="h-4 w-4 text-muted-foreground" />
          </div>

          {/* Actions */}
          <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {idea.status === 'ready' && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-emerald-400 hover:text-emerald-300"
                onClick={(e) => {
                  e.stopPropagation();
                  onPromote(idea);
                }}
                title="Promote to Feature"
                data-testid={`promote-idea-${idea.id}`}
              >
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(idea);
              }}
              title="Delete idea"
              data-testid={`delete-idea-${idea.id}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* Content */}
          <div className="p-3 pl-8 pr-10">
            <p className="font-medium text-foreground line-clamp-2 leading-snug">{idea.title}</p>
            {idea.description && (
              <p className="mt-1 text-xs text-muted-foreground line-clamp-2 leading-snug">
                {idea.description}
              </p>
            )}

            {/* Status badge */}
            <div className="mt-2 flex items-center gap-2">
              <span
                className={cn(
                  'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
                  STATUS_COLORS[idea.status] ?? STATUS_COLORS.raw
                )}
              >
                {idea.status}
              </span>
              <span className="text-[10px] text-muted-foreground">{idea.category}</span>
            </div>
          </div>
        </Card>
      </div>

      <IdeaEditModal
        idea={idea}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSave={handleSave}
        isSaving={isSaving}
      />
    </>
  );
});
