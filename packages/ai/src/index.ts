export { IllegalAgentChoiceError, isOffered } from './agent.js';
export type { Agent } from './agent.js';

export { FirstActionAgent, RandomAgent } from './random.js';

export { DEFAULT_WEIGHTS, HeuristicAgent, heuristicAgent, scorePosition } from './heuristic.js';
export type { HeuristicOptions, HeuristicWeights } from './heuristic.js';

export { SearchAgent } from './search.js';
export type { SearchOptions } from './search.js';

export { playGame } from './match.js';
export type { MatchOptions, MatchResult } from './match.js';
