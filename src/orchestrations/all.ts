/** Side-effect import: registers every arm. A, B and C live in registry.ts. */
import { singleAgent } from '../baseline/single-agent.js';
import { jevAssisted } from './jev-assisted.js';
import { registerOrchestration } from './registry.js';

registerOrchestration(jevAssisted('A'));
registerOrchestration(singleAgent);
