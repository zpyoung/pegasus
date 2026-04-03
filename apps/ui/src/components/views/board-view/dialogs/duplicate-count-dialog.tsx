import { useState, useEffect } from 'react';
import { Copy } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { HotkeyButton } from '@/components/ui/hotkey-button';
import { Input } from '@/components/ui/input';

interface DuplicateCountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (count: number) => void;
  featureTitle?: string;
}

export function DuplicateCountDialog({
  open,
  onOpenChange,
  onConfirm,
  featureTitle,
}: DuplicateCountDialogProps) {
  const [count, setCount] = useState(2);

  // Reset count when dialog opens
  useEffect(() => {
    if (open) {
      setCount(2);
    }
  }, [open]);

  const handleConfirm = () => {
    if (count >= 1 && count <= 50) {
      onConfirm(count);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy className="w-5 h-5 text-primary" />
            Duplicate as Child ×N
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Creates a chain of duplicates where each is a child of the previous, so they execute
            sequentially.
            {featureTitle && (
              <span className="block mt-1 text-xs">
                Source: <span className="font-medium">{featureTitle}</span>
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <label htmlFor="duplicate-count" className="text-sm text-muted-foreground mb-2 block">
            Number of copies
          </label>
          <Input
            id="duplicate-count"
            type="number"
            min={1}
            max={50}
            value={count}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val)) {
                setCount(Math.min(50, Math.max(1, val)));
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleConfirm();
              }
            }}
            className="w-full"
            autoFocus
          />
          <p className="text-xs text-muted-foreground mt-1.5">Enter a number between 1 and 50</p>
        </div>

        <DialogFooter className="gap-2 sm:gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="px-4">
            Cancel
          </Button>
          <HotkeyButton
            variant="default"
            onClick={handleConfirm}
            hotkey={{ key: 'Enter', cmdCtrl: true }}
            hotkeyActive={open}
            className="px-4"
            disabled={count < 1 || count > 50}
          >
            <Copy className="w-4 h-4 mr-2" />
            Create {count} {count === 1 ? 'Copy' : 'Copies'}
          </HotkeyButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
