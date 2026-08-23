import { invoke } from '@tauri-apps/api/core';
import { BaseDirectory, remove, writeTextFile } from '@tauri-apps/plugin-fs';

const STORYOS_MANUSCRIPT_SIDECAR = '../sidecars/storyos-manuscript/bin/storyos-manuscript';
const PAYLOAD_SCHEMA = 'story.manuscript-write-payload.v1';
const RESPONSE_SCHEMA = 'story.manuscript-save.v1';
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PAYLOAD_NAME_RE = /^cle-storyos-manuscript-[0-9a-f]{32}\.json$/;

interface ShellExecuteOutput {
  code: number | null;
  signal: number | null;
  stdout: string;
  stderr: string;
}

export interface StoryOsManuscriptSaveSuccess {
  schema: 'story.manuscript-save.v1';
  status: 'saved' | 'unchanged';
  project_id: string;
  path: string;
  previous_sha256: string;
  sha256: string;
  bytes: number;
  characters: number;
  lines: number;
  policy: {
    manuscript_mutation: true;
    canonical_mutation: false;
    staging_mutation: false;
  };
}

export interface StoryOsManuscriptSaveConflict {
  schema: 'story.manuscript-save.v1';
  status: 'conflict';
  expected_sha256: string;
  current_sha256: string;
  policy: {
    manuscript_mutation: false;
    canonical_mutation: false;
    staging_mutation: false;
  };
}

export type StoryOsManuscriptSaveResult =
  | StoryOsManuscriptSaveSuccess
  | StoryOsManuscriptSaveConflict;

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty`);
  if (/\r|\n|\0/.test(trimmed)) throw new Error(`${label} contains invalid control characters`);
  return trimmed;
}

function requireRelativePath(value: string): string {
  const path = requireNonEmpty(value, 'StoryOS manuscript path');
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\')) {
    throw new Error('StoryOS manuscript path must be project-relative');
  }
  const parts = path.split(/[\\/]+/);
  if (parts.some((part) => part === '..' || part === '.')) {
    throw new Error('StoryOS manuscript path contains an invalid segment');
  }
  return path;
}

function requireSha256(value: string): string {
  const sha = value.trim().toLowerCase();
  if (!SHA256_RE.test(sha)) throw new Error('StoryOS manuscript SHA-256 is invalid');
  return sha;
}

function randomPayloadName(): string {
  const hex = crypto.randomUUID().replaceAll('-', '').toLowerCase();
  const name = `cle-storyos-manuscript-${hex}.json`;
  if (!PAYLOAD_NAME_RE.test(name)) throw new Error('Failed to generate a valid StoryOS payload name');
  return name;
}

function assertResult(value: unknown): StoryOsManuscriptSaveResult {
  if (!value || typeof value !== 'object') throw new Error('StoryOS manuscript writer returned invalid JSON');
  const result = value as Partial<StoryOsManuscriptSaveResult>;
  if (result.schema !== RESPONSE_SCHEMA) throw new Error('StoryOS manuscript writer response schema mismatch');
  if (result.status !== 'saved' && result.status !== 'unchanged' && result.status !== 'conflict') {
    throw new Error('StoryOS manuscript writer returned an unknown status');
  }
  return result as StoryOsManuscriptSaveResult;
}

export async function saveStoryOsManuscriptWorkingCopy(input: {
  projectPath: string;
  relativePath: string;
  expectedSha256: string;
  content: string;
}): Promise<StoryOsManuscriptSaveResult> {
  const projectPath = requireNonEmpty(input.projectPath, 'StoryOS project path');
  const relativePath = requireRelativePath(input.relativePath);
  const expectedSha256 = requireSha256(input.expectedSha256);
  const content = input.content;
  if (typeof content !== 'string') throw new Error('StoryOS manuscript content must be text');

  const payloadName = randomPayloadName();
  const payload = JSON.stringify({
    schema: PAYLOAD_SCHEMA,
    path: relativePath,
    expected_sha256: expectedSha256,
    content,
  });
  if (new TextEncoder().encode(payload).byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error('StoryOS manuscript write payload exceeds the 16 MiB safety limit');
  }

  await writeTextFile(payloadName, payload, { baseDir: BaseDirectory.Temp });
  try {
    const output = await invoke<ShellExecuteOutput>('plugin:shell|execute', {
      program: STORYOS_MANUSCRIPT_SIDECAR,
      args: ['save', projectPath, payloadName],
      options: { sidecar: true },
    });
    if (output.code !== 0) {
      const detail = (output.stderr || output.stdout || `exit code ${String(output.code)}`).trim();
      throw new Error(`StoryOS manuscript writer failed: ${detail.slice(0, 4096)}`);
    }
    try {
      return assertResult(JSON.parse(output.stdout));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`StoryOS manuscript writer returned invalid JSON: ${String(error)}`);
      }
      throw error;
    }
  } finally {
    await remove(payloadName, { baseDir: BaseDirectory.Temp }).catch(() => undefined);
  }
}
