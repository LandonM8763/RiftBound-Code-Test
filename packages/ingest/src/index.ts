export { APITCG_SOURCE, canonicalName, championTagFromName, parseCardType, plainText, timingFromText } from './apitcg.js';
export { COMMUNITY_SOURCE, stripHtml } from './community.js';
export {
  parseCardText,
  parseCondition,
  parseEffects,
  parseStatePredicate,
  parseStatic,
  splitCondition,
  stripReminders,
} from './text.js';
export type { ParsedText } from './text.js';

export { summarizeGaps } from './gaps.js';
export type { Gap, GapSummary } from './gaps.js';
export type { CardSource, IngestResult } from './source.js';
