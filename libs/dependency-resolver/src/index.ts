/**
 * @pegasus/dependency-resolver
 * Feature dependency resolution for Pegasus
 */

export {
  resolveDependencies,
  areDependenciesSatisfied,
  getBlockingDependencies,
  createFeatureMap,
  getBlockingDependenciesFromMap,
  wouldCreateCircularDependency,
  dependencyExists,
  getAncestors,
  formatAncestorContextForPrompt,
  type DependencyResolutionResult,
  type DependencySatisfactionOptions,
  type AncestorContext,
} from './resolver.js';
