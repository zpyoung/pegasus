# Adding New Cursor Models to Pegasus

This guide explains how to add new Cursor models to Pegasus. The process revolves around a generated model registry — in most cases you only need to update one source file and run a single command.

## How the Model Pipeline Works

```
scripts/sync-models/adapters/cursor.ts   <- hand-maintained source list
        |
        v  pnpm sync-models
libs/types/src/model-registry.gen.ts     <- GENERATED (do not edit directly)
        |
        v  re-exported by
libs/types/src/cursor-models.ts          <- CursorModelId type + CURSOR_MODEL_MAP
        |
        v  consumed by
apps/ui/src/components/views/settings-view/providers/
  cursor-settings-tab.tsx                <- Cursor settings page (model config shell)
  cursor-model-configuration.tsx         <- Model enable/disable + default picker
```

`CursorModelId` is a TypeScript union **derived** from the generated registry — it is **not** hand-maintained. Do not edit `model-registry.gen.ts` directly; it carries a `DO NOT EDIT` header and is overwritten on every sync.

All model IDs use the `cursor-` prefix (e.g., `cursor-sonnet-4.6`, `cursor-composer-1`). Bare IDs without the prefix exist only in `LegacyCursorModelId` for migration compatibility and must not be used for new models.

---

## Workflow A — Adding a Model (Standard)

Cursor has no public model-listing API, so the model list is maintained by hand in the adapter. The general update cycle is:

1. **Update the adapter source list**
2. **Run `pnpm sync-models`** to regenerate the registry
3. **Update `cursor-models.ts`** if you need custom display metadata or grouping
4. **Verify** the model appears in the UI

### Step 1: Edit the Cursor Adapter

Open `scripts/sync-models/adapters/cursor.ts` and add an entry to the `CURSOR_MODELS` array. Use the `cursor-` prefixed ID exactly as Cursor's CLI / API expects it.

```typescript
// scripts/sync-models/adapters/cursor.ts

const CURSOR_MODELS: ModelEntry[] = [
  // ... existing models ...

  {
    id: 'cursor-my-new-model',          // Must use cursor- prefix
    name: 'My New Model',               // Human-readable name
    provider: 'cursor',
    supportsVision: true,               // true for most Claude and Gemini models
    supportsThinking: false,            // true if model has extended thinking
    reasoningCapable: false,
    stabilityTier: 'ga',               // 'ga' | 'preview' | 'beta'
    pricing: { inputPerMToken: 3, outputPerMToken: 15 },
  },
];
```

Also update the `Last updated` date comment at the top of the file.

### Step 2: Regenerate the Registry

```bash
pnpm sync-models
```

This rewrites `libs/types/src/model-registry.gen.ts` and automatically expands the `CursorModelId` union type. No manual type editing is needed.

### Step 3: Add Display Metadata to `cursor-models.ts`

The generated registry provides the raw model ID. Open `libs/types/src/cursor-models.ts` and add an entry to `CURSOR_MODEL_MAP` with the display metadata the UI needs:

```typescript
// libs/types/src/cursor-models.ts

export const CURSOR_MODEL_MAP: Record<CursorModelId, CursorModelConfig> = {
  // ... existing entries ...

  'cursor-my-new-model': {
    id: 'cursor-my-new-model',
    label: 'My New Model',
    description: 'Short description shown under the model name in the UI',
    hasThinking: false,
    supportsVision: true,
  },
};
```

If `supportsVision` is `true`, the model can accept image inputs. Most Claude and Gemini models support vision. Codex and Composer models generally do not.

### Step 4: (Optional) Configure Grouping

If your new model is a variant of an existing model (e.g., a "fast" or "max" tier), add it to `CURSOR_MODEL_GROUPS` so the UI collapses it into a variant picker rather than showing it as a separate card:

```typescript
// libs/types/src/cursor-models.ts

export const CURSOR_MODEL_GROUPS: GroupedModel[] = [
  // ... existing groups ...

  {
    baseId: 'cursor-my-new-model-group',
    label: 'My New Model',
    description: 'Description of the model family',
    variantType: 'compute',   // 'compute' | 'thinking' | 'capacity'
    variants: [
      { id: 'cursor-my-new-model', label: 'Standard', description: 'Default speed' },
      { id: 'cursor-my-new-model-fast', label: 'Fast', description: 'Faster output', badge: 'Fast' },
    ],
  },
];
```

If the model is standalone (not part of a family), add its ID to `STANDALONE_CURSOR_MODELS` instead:

```typescript
export const STANDALONE_CURSOR_MODELS: CursorModelId[] = [
  // ... existing entries ...
  'cursor-my-new-model',
];
```

### Step 5: Rebuild the Types Package

```bash
pnpm --filter @pegasus/types build
```

### Step 6: Verify

The model will appear in:

- **Settings > Cursor tab** — Model Configuration section (enable/disable, set default)
- **Add/Edit Feature dialog** — Model tab, Cursor provider section
- **AI Profiles** — Cursor provider model selection

---

## Workflow B — Display Metadata Only (No New Model ID)

If the model is already in the generated registry but you want to override its display name, add aliases, or mark it as a default, edit `libs/types/src/model-overrides.json`:

```json
{
  "cursor-my-new-model": {
    "name": "Preferred Display Name",
    "defaultFor": "cursor",
    "stabilityTier": "ga"
  }
}
```

The file header documents all available override fields. Run `pnpm sync-models` afterward so the overrides are baked into the next generated output.

---

## Model Config Fields Reference

### `CURSOR_MODEL_MAP` entry (`CursorModelConfig`)

| Field            | Type      | Description                                                                 |
| ---------------- | --------- | --------------------------------------------------------------------------- |
| `id`             | `CursorModelId` | Must match the generated registry ID (with `cursor-` prefix)          |
| `label`          | `string`  | Human-readable name shown in the UI                                         |
| `description`    | `string`  | Tooltip/subtext explaining the model                                        |
| `hasThinking`    | `boolean` | `true` if the model supports extended thinking/reasoning output             |
| `supportsVision` | `boolean` | `true` if the model accepts image inputs (most Claude and Gemini models do) |

### `CURSOR_MODELS` adapter entry (`ModelEntry`)

| Field              | Type      | Description                                          |
| ------------------ | --------- | ---------------------------------------------------- |
| `id`               | `string`  | `cursor-`-prefixed model ID                          |
| `name`             | `string`  | Canonical name (may be overridden by model-overrides.json) |
| `provider`         | `string`  | Always `'cursor'` for this adapter                   |
| `supportsVision`   | `boolean` | Whether the model accepts image inputs               |
| `supportsThinking` | `boolean` | Whether the model has extended thinking              |
| `reasoningCapable` | `boolean` | Whether the model performs multi-step reasoning      |
| `stabilityTier`    | `string`  | `'ga'` \| `'preview'` \| `'beta'`                   |
| `pricing`          | `object`  | `{ inputPerMToken, outputPerMToken }` in USD         |

---

## Legacy Model IDs

Bare IDs without the `cursor-` prefix (e.g., `sonnet-4.6`, `composer-1`) are stored in `LegacyCursorModelId` and mapped to their canonical replacements via `LEGACY_CURSOR_MODEL_MAP`. These exist only for migrating old persisted settings — do not use bare IDs for new models.

---

## Provider Routing

When Pegasus executes a feature with a Cursor model:

1. The model string is stored with the `cursor-` prefix (e.g., `cursor-sonnet-4.6`)
2. `ProviderFactory.getProviderNameForModel()` detects the `cursor-` prefix and selects `CursorProvider`
3. `CursorProvider` strips the prefix and passes the bare ID to the Cursor CLI

---

## Checklist

- [ ] Added entry to `CURSOR_MODELS` in `scripts/sync-models/adapters/cursor.ts`
- [ ] Updated the `Last updated` date in the adapter file
- [ ] Ran `pnpm sync-models` to regenerate `model-registry.gen.ts`
- [ ] Added entry to `CURSOR_MODEL_MAP` in `libs/types/src/cursor-models.ts`
- [ ] Added to `CURSOR_MODEL_GROUPS` (if variant) or `STANDALONE_CURSOR_MODELS` (if standalone)
- [ ] Rebuilt types package (`pnpm --filter @pegasus/types build`)
- [ ] Verified model appears in Settings > Cursor tab
- [ ] Verified model appears in Add/Edit Feature dialog
- [ ] Tested execution with new model if Cursor CLI supports it

---

## Reference

- Cursor model pricing and IDs: https://cursor.com/docs/models-and-pricing#premium-routing
- Adapter source: `scripts/sync-models/adapters/cursor.ts`
- Generated registry (do not edit): `libs/types/src/model-registry.gen.ts`
- Display metadata overrides: `libs/types/src/model-overrides.json`
- Model map and grouping: `libs/types/src/cursor-models.ts`
- Settings UI: `apps/ui/src/components/views/settings-view/providers/cursor-settings-tab.tsx`
- Model configuration component: `apps/ui/src/components/views/settings-view/providers/cursor-model-configuration.tsx`
