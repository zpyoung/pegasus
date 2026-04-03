import { useAppStore } from '@/store/app-store';
import { useThemePreview } from './use-theme-preview';

/**
 * Hook that manages project theme state and preview handlers
 */
export function useProjectTheme() {
  // Get theme-related values from store
  const { theme: globalTheme, setTheme, setProjectTheme, setPreviewTheme } = useAppStore();

  // Get debounced preview handlers
  const { handlePreviewEnter, handlePreviewLeave } = useThemePreview({ setPreviewTheme });

  return {
    // Theme state
    globalTheme,
    setTheme,
    setProjectTheme,
    setPreviewTheme,

    // Preview handlers
    handlePreviewEnter,
    handlePreviewLeave,
  };
}
