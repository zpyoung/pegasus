import { useMemo } from "react";
import { useAppStore, defaultBackgroundSettings } from "@/store/app-store";
import { getAuthenticatedImageUrl } from "@/lib/api-fetch";

interface UseBoardBackgroundProps {
  currentProject: { path: string; id: string } | null;
}

export function useBoardBackground({
  currentProject,
}: UseBoardBackgroundProps) {
  // Subscribe to the per-project background settings object directly rather than
  // the full boardBackgroundByProject map. This prevents re-renders when a DIFFERENT
  // project's background settings change — the selector returns null/undefined when
  // no project is loaded, which is referentially stable.
  const perProjectSettings = useAppStore((state) =>
    currentProject ? state.boardBackgroundByProject[currentProject.path] : null,
  );

  // Get background settings for current project
  const backgroundSettings = useMemo(
    () => perProjectSettings || defaultBackgroundSettings,
    [perProjectSettings],
  );

  // Build background image style if image exists
  const backgroundImageStyle = useMemo(() => {
    if (!backgroundSettings.imagePath || !currentProject) {
      return {};
    }

    const imageUrl = getAuthenticatedImageUrl(
      backgroundSettings.imagePath,
      currentProject.path,
      backgroundSettings.imageVersion,
    );

    return {
      backgroundImage: `url(${imageUrl})`,
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
    } as React.CSSProperties;
  }, [backgroundSettings, currentProject]);

  return {
    backgroundSettings,
    backgroundImageStyle,
  };
}
