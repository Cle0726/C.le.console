const CODEX_NON_CHAT_MODELS = new Set([
  "codex-auto-review",
  "gpt-image-2",
  "grok-imagine-image",
  "grok-imagine-image-quality",
  "grok-imagine-video",
]);

export function isCodexChatTestModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return false;
  const baseModel = normalized.split("/").pop() ?? normalized;
  return !CODEX_NON_CHAT_MODELS.has(baseModel);
}
