/**
 * @pegasus/spec-parser
 *
 * XML spec parser for Pegasus - parses and generates app_spec.txt XML.
 * This package provides utilities for:
 * - Parsing XML spec content into SpecOutput objects
 * - Converting SpecOutput objects back to XML
 * - Validating spec data
 */

// Re-export types from @pegasus/types for convenience
export type { SpecOutput } from '@pegasus/types';

// XML utilities
export { escapeXml, unescapeXml, extractXmlSection, extractXmlElements } from './xml-utils.js';

// XML to Spec parsing
export { xmlToSpec } from './xml-to-spec.js';
export type { ParseResult } from './xml-to-spec.js';

// Spec to XML conversion
export { specToXml } from './spec-to-xml.js';

// Validation
export { validateSpec, isValidSpecXml } from './validate.js';
export type { ValidationResult } from './validate.js';
