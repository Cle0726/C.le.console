export const MODEL_GEOMETRY_VARIANTS = [
  'gpt',
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'github',
] as const;

export type WebGLModelVariant = (typeof MODEL_GEOMETRY_VARIANTS)[number];
