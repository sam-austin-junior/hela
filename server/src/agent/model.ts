import { config, modelProvider } from '../config.js';
import { anthropicModel, type ModelClient } from './orchestrator.js';
import { groqModel } from './groq.js';

/** The configured model, or null when no provider has a key. */
export function createModel(): ModelClient | null {
  switch (modelProvider()) {
    case 'anthropic':
      return anthropicModel();
    case 'groq':
      return groqModel(config.groqApiKey!, config.groqModel);
    default:
      return null;
  }
}
