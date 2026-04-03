/**
 * Enhancement Prompts - Re-exported from @pegasus/prompts
 *
 * This file now re-exports enhancement prompts from the shared @pegasus/prompts package
 * to maintain backward compatibility with existing imports in the server codebase.
 */

export {
  IMPROVE_SYSTEM_PROMPT,
  TECHNICAL_SYSTEM_PROMPT,
  SIMPLIFY_SYSTEM_PROMPT,
  ACCEPTANCE_SYSTEM_PROMPT,
  IMPROVE_EXAMPLES,
  TECHNICAL_EXAMPLES,
  SIMPLIFY_EXAMPLES,
  ACCEPTANCE_EXAMPLES,
  getEnhancementPrompt,
  getSystemPrompt,
  getExamples,
  buildUserPrompt,
  isValidEnhancementMode,
  getAvailableEnhancementModes,
} from '@pegasus/prompts';

export type { EnhancementMode, EnhancementExample } from '@pegasus/prompts';
