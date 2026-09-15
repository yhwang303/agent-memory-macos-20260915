/**
 * XML Parser Module
 * Parses observation and summary XML blocks from SDK responses
 * 
 * Adapted from claude-mem for CodeBuddy Agent
 */

import { logger } from '../utils/logger.js';
import { OBSERVATION_TYPES, ObservationType } from './prompts.js';

export interface ParsedObservation {
  type: ObservationType;
  title: string | null;
  subtitle: string | null;
  meta_intent: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

export interface ParsedSummary {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  media_context: string | null;
  meta_intent: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
}

/**
 * Parse observation XML blocks from SDK response
 */
export function parseObservations(text: string, correlationId?: string): ParsedObservation[] {
  const observations: ParsedObservation[] = [];
  const observationRegex = /<observation>([\s\S]*?)<\/observation>/g;

  let match;
  while ((match = observationRegex.exec(text)) !== null) {
    const obsContent = match[1];

    const type = extractField(obsContent, 'type');
    const title = extractField(obsContent, 'title');
    const subtitle = extractField(obsContent, 'subtitle');
    const meta_intent = extractField(obsContent, 'meta_intent');
    const narrative = extractField(obsContent, 'narrative');
    const facts = extractArrayElements(obsContent, 'facts', 'fact');
    const concepts = extractArrayElements(obsContent, 'concepts', 'concept');
    const files_read = extractArrayElements(obsContent, 'files_read', 'file');
    const files_modified = extractArrayElements(obsContent, 'files_modified', 'file');

    // Validate and default type
    const fallbackType: ObservationType = 'discovery';
    let finalType: ObservationType = fallbackType;
    
    if (type) {
      const trimmedType = type.trim() as ObservationType;
      if (OBSERVATION_TYPES.includes(trimmedType)) {
        finalType = trimmedType;
      } else {
        logger.warn('PARSER', 'Invalid observation type, using fallback', {
          correlationId,
          invalidType: type,
          fallback: fallbackType
        });
      }
    }

    // Filter out type from concepts
    const cleanedConcepts = concepts.filter(c => c !== finalType);

    observations.push({
      type: finalType,
      title,
      subtitle,
      meta_intent,
      facts,
      narrative,
      concepts: cleanedConcepts,
      files_read,
      files_modified
    });
  }

  return observations;
}

/**
 * Parse summary XML block from SDK response
 */
export function parseSummary(text: string, sessionId?: number): ParsedSummary | null {
  // Check for skip_summary
  const skipRegex = /<skip_summary\s+reason="([^"]+)"\s*\/>/;
  const skipMatch = skipRegex.exec(text);

  if (skipMatch) {
    logger.info('PARSER', 'Summary skipped', { sessionId, reason: skipMatch[1] });
    return null;
  }

  const summaryRegex = /<summary>([\s\S]*?)<\/summary>/;
  const summaryMatch = summaryRegex.exec(text);

  if (!summaryMatch) {
    return null;
  }

  const summaryContent = summaryMatch[1];

  return {
    request: extractField(summaryContent, 'request'),
    investigated: extractField(summaryContent, 'investigated'),
    learned: extractField(summaryContent, 'learned'),
    media_context: extractField(summaryContent, 'media_context'),
    meta_intent: extractField(summaryContent, 'meta_intent'),
    completed: extractField(summaryContent, 'completed'),
    next_steps: extractField(summaryContent, 'next_steps'),
    notes: extractField(summaryContent, 'notes')
  };
}

/**
 * Check if response indicates a skip
 */
export function isSkipResponse(text: string): { skip: boolean; reason?: string } {
  const skipRegex = /<skip\s+reason="([^"]+)"\s*\/>/;
  const match = skipRegex.exec(text);
  
  if (match) {
    return { skip: true, reason: match[1] };
  }
  return { skip: false };
}

/**
 * Extract a simple field value from XML content
 */
function extractField(content: string, fieldName: string): string | null {
  const regex = new RegExp('<' + fieldName + '>([^<]*)</' + fieldName + '>');
  const match = regex.exec(content);
  if (!match) return null;

  const trimmed = match[1].trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Extract array of elements from XML content
 */
function extractArrayElements(content: string, arrayName: string, elementName: string): string[] {
  const elements: string[] = [];

  const arrayRegex = new RegExp('<' + arrayName + '>(.*?)</' + arrayName + '>', 's');
  const arrayMatch = arrayRegex.exec(content);

  if (!arrayMatch) {
    return elements;
  }

  const arrayContent = arrayMatch[1];
  const elementRegex = new RegExp('<' + elementName + '>([^<]+)</' + elementName + '>', 'g');
  
  let elementMatch;
  while ((elementMatch = elementRegex.exec(arrayContent)) !== null) {
    elements.push(elementMatch[1].trim());
  }

  return elements;
}
