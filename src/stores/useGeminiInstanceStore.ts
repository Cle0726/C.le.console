import * as geminiInstanceService from '../services/geminiInstanceService';
import { createInstanceStore } from './createInstanceStore';

export const useGeminiInstanceStore = createInstanceStore(
  geminiInstanceService,
  'agtools.gemini.instances.cache',
);
