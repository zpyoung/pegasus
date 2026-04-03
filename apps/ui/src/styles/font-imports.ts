/**
 * Font Loading Strategy for Mobile PWA Performance
 *
 * Critical fonts (Zed Sans/Mono - used as Geist fallback) are loaded eagerly.
 * All other fonts are lazy-loaded on demand when the user selects them
 * in font customization settings. This dramatically reduces initial bundle
 * size and speeds up mobile PWA loading.
 *
 * Font loading is split into:
 * 1. Critical path: Zed fonts (default/fallback fonts) - loaded synchronously
 * 2. Deferred path: All @fontsource fonts - loaded on-demand or after idle
 */

// Critical: Zed Fonts (default fallback) - loaded immediately
import '@/assets/fonts/zed/zed-fonts.css';

/**
 * Registry of lazy-loadable font imports.
 * Each font family maps to a function that dynamically imports its CSS files.
 * This ensures fonts are only downloaded when actually needed.
 */
type FontLoader = () => Promise<void>;

const fontLoaders: Record<string, FontLoader> = {
  // Sans-serif / UI Fonts
  Inter: async () => {
    await Promise.all([
      import('@fontsource/inter/400.css'),
      import('@fontsource/inter/500.css'),
      import('@fontsource/inter/600.css'),
      import('@fontsource/inter/700.css'),
    ]);
  },
  Roboto: async () => {
    await Promise.all([
      import('@fontsource/roboto/400.css'),
      import('@fontsource/roboto/500.css'),
      import('@fontsource/roboto/700.css'),
    ]);
  },
  'Open Sans': async () => {
    await Promise.all([
      import('@fontsource/open-sans/400.css'),
      import('@fontsource/open-sans/500.css'),
      import('@fontsource/open-sans/600.css'),
      import('@fontsource/open-sans/700.css'),
    ]);
  },
  Montserrat: async () => {
    await Promise.all([
      import('@fontsource/montserrat/400.css'),
      import('@fontsource/montserrat/500.css'),
      import('@fontsource/montserrat/600.css'),
      import('@fontsource/montserrat/700.css'),
    ]);
  },
  Lato: async () => {
    await Promise.all([import('@fontsource/lato/400.css'), import('@fontsource/lato/700.css')]);
  },
  Poppins: async () => {
    await Promise.all([
      import('@fontsource/poppins/400.css'),
      import('@fontsource/poppins/500.css'),
      import('@fontsource/poppins/600.css'),
      import('@fontsource/poppins/700.css'),
    ]);
  },
  Raleway: async () => {
    await Promise.all([
      import('@fontsource/raleway/400.css'),
      import('@fontsource/raleway/500.css'),
      import('@fontsource/raleway/600.css'),
      import('@fontsource/raleway/700.css'),
    ]);
  },
  'Work Sans': async () => {
    await Promise.all([
      import('@fontsource/work-sans/400.css'),
      import('@fontsource/work-sans/500.css'),
      import('@fontsource/work-sans/600.css'),
      import('@fontsource/work-sans/700.css'),
    ]);
  },
  'Source Sans 3': async () => {
    await Promise.all([
      import('@fontsource/source-sans-3/400.css'),
      import('@fontsource/source-sans-3/500.css'),
      import('@fontsource/source-sans-3/600.css'),
      import('@fontsource/source-sans-3/700.css'),
    ]);
  },

  // Monospace / Code Fonts
  'Fira Code': async () => {
    await Promise.all([
      import('@fontsource/fira-code/400.css'),
      import('@fontsource/fira-code/500.css'),
      import('@fontsource/fira-code/600.css'),
      import('@fontsource/fira-code/700.css'),
    ]);
  },
  'JetBrains Mono': async () => {
    await Promise.all([
      import('@fontsource/jetbrains-mono/400.css'),
      import('@fontsource/jetbrains-mono/500.css'),
      import('@fontsource/jetbrains-mono/600.css'),
      import('@fontsource/jetbrains-mono/700.css'),
    ]);
  },
  'Cascadia Code': async () => {
    await Promise.all([
      import('@fontsource/cascadia-code/400.css'),
      import('@fontsource/cascadia-code/600.css'),
      import('@fontsource/cascadia-code/700.css'),
    ]);
  },
  Iosevka: async () => {
    await Promise.all([
      import('@fontsource/iosevka/400.css'),
      import('@fontsource/iosevka/500.css'),
      import('@fontsource/iosevka/600.css'),
      import('@fontsource/iosevka/700.css'),
    ]);
  },
  Inconsolata: async () => {
    await Promise.all([
      import('@fontsource/inconsolata/400.css'),
      import('@fontsource/inconsolata/500.css'),
      import('@fontsource/inconsolata/600.css'),
      import('@fontsource/inconsolata/700.css'),
    ]);
  },
  'Source Code Pro': async () => {
    await Promise.all([
      import('@fontsource/source-code-pro/400.css'),
      import('@fontsource/source-code-pro/500.css'),
      import('@fontsource/source-code-pro/600.css'),
      import('@fontsource/source-code-pro/700.css'),
    ]);
  },
  'IBM Plex Mono': async () => {
    await Promise.all([
      import('@fontsource/ibm-plex-mono/400.css'),
      import('@fontsource/ibm-plex-mono/500.css'),
      import('@fontsource/ibm-plex-mono/600.css'),
      import('@fontsource/ibm-plex-mono/700.css'),
    ]);
  },
};

// Track which fonts have been loaded to avoid duplicate loading
const loadedFonts = new Set<string>();

/**
 * Load a specific font family on demand.
 * Returns immediately if the font is already loaded.
 * Safe to call multiple times - font will only be loaded once.
 */
export async function loadFont(fontFamily: string): Promise<void> {
  // Extract the primary font name from CSS font-family string
  // e.g., "'JetBrains Mono', monospace" -> "JetBrains Mono"
  const primaryFont = fontFamily
    .split(',')[0]
    .trim()
    .replace(/^['"]|['"]$/g, '');

  if (loadedFonts.has(primaryFont)) return;

  const loader = fontLoaders[primaryFont];
  if (loader) {
    try {
      await loader();
      loadedFonts.add(primaryFont);
    } catch (error) {
      // Font loading failed silently - system fallback fonts will be used
      console.warn(`Failed to load font: ${primaryFont}`, error);
    }
  }
}

/**
 * Load fonts that the user has configured (from localStorage).
 * Called during app initialization to ensure custom fonts are available
 * before the first render completes.
 */
export function loadUserFonts(): void {
  try {
    const stored = localStorage.getItem('pegasus-storage');
    if (!stored) return;

    const data = JSON.parse(stored);
    const state = data?.state;

    // Load globally configured fonts
    if (state?.fontFamilySans && state.fontFamilySans !== 'default') {
      loadFont(state.fontFamilySans);
    }
    if (state?.fontFamilyMono && state.fontFamilyMono !== 'default') {
      loadFont(state.fontFamilyMono);
    }

    // Load current project's font overrides
    const currentProject = state?.currentProject;
    if (currentProject?.fontSans && currentProject.fontSans !== 'default') {
      loadFont(currentProject.fontSans);
    }
    if (currentProject?.fontMono && currentProject.fontMono !== 'default') {
      loadFont(currentProject.fontMono);
    }
  } catch {
    // localStorage not available or parse error - ignore
  }
}

/**
 * Preload all available fonts during idle time.
 * Called after the app is fully loaded to ensure font previews
 * in settings work instantly.
 */
export function preloadAllFonts(): void {
  const idleCallback =
    typeof requestIdleCallback !== 'undefined'
      ? requestIdleCallback
      : (cb: () => void) => setTimeout(cb, 100);

  // Load fonts in batches during idle periods to avoid blocking
  const fontNames = Object.keys(fontLoaders);
  let index = 0;

  function loadNextBatch() {
    const batchSize = 2; // Load 2 fonts per idle callback
    const end = Math.min(index + batchSize, fontNames.length);

    for (let i = index; i < end; i++) {
      const fontName = fontNames[i];
      if (!loadedFonts.has(fontName)) {
        fontLoaders[fontName]()
          .then(() => {
            loadedFonts.add(fontName);
          })
          .catch(() => {
            // Silently ignore preload failures
          });
      }
    }

    index = end;
    if (index < fontNames.length) {
      idleCallback(loadNextBatch);
    }
  }

  idleCallback(loadNextBatch);
}
