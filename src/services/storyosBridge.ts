import { invoke } from '@tauri-apps/api/core';

const STORYOS_SIDECAR = '../sidecars/storyos-workspace/bin/storyos-workspace';
const MAX_ERROR_CHARS = 4096;
const ENTITY_ID_RE = /^[a-z]+_[0-9a-f]{32}$/;

interface ShellExecuteOutput {
  code: number | null;
  signal: number | null;
  stdout: string;
  stderr: string;
}

export interface StoryOsManuscriptSummary {
  path: string;
  name: string;
  title: string;
  season: number | null;
  episode: number | null;
  bytes: number;
  characters: number;
  lines: number;
  sha256: string;
}

export interface StoryOsEntitySummary {
  id: string;
  kind: string;
  name: string;
  slug: string;
  aliases: string[];
  data: Record<string, unknown>;
  state: {
    values: Record<string, unknown>;
    knowledge_count: number;
    resolved_plot_count: number;
  };
  counts: {
    events: number;
    events_total: number;
    canon_facts: number;
    active_canon_facts: number;
    claims: number;
  };
  latest_event_sequence: number | null;
}

export interface StoryOsWorkspaceSnapshot {
  schema: 'story.authoring-workspace.v1';
  project: {
    id: string;
    name: string;
    language: string;
    paths: Record<string, unknown>;
    import: Record<string, unknown>;
  };
  timeline: {
    requested_through_sequence: number | null;
    effective_through_sequence: number | null;
    latest_event_sequence: number | null;
    events: number;
    events_total: number;
  };
  summary: Record<string, number>;
  manuscripts: StoryOsManuscriptSummary[];
  entities: StoryOsEntitySummary[];
  canon: { authorities: Record<string, number> };
  workflow: Record<string, unknown>;
  diagnostics: { reference_errors: string[] };
  context: Record<string, unknown>;
  policy: {
    read_only: true;
    canonical_mutation: false;
    staging_mutation: false;
    mutation_commands_are_separate: true;
  };
}

export interface StoryOsEntityView {
  schema: 'story.authoring-entity.v1';
  project_id: string;
  through_sequence: number | null;
  entity: {
    id: string;
    kind: string;
    name: string;
    slug: string;
    aliases: string[];
    data: Record<string, unknown>;
  };
  state: {
    values: Record<string, unknown>;
    knowledge: string[];
    resolved_plots: string[];
  };
  events: Array<Record<string, unknown>>;
  canon_facts: Array<Record<string, unknown>>;
  claims: Array<Record<string, unknown>>;
  workflow: Record<string, unknown>;
  policy: {
    read_only: true;
    canonical_mutation: false;
    staging_mutation: false;
  };
}

export interface StoryOsManuscriptView {
  schema: 'story.authoring-manuscript.v1';
  project_id: string;
  path: string;
  title: string;
  season: number | null;
  episode: number | null;
  bytes: number;
  characters: number;
  lines: number;
  sha256: string;
  content: string;
  policy: {
    read_only: true;
    canonical_mutation: false;
    staging_mutation: false;
  };
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty`);
  if (/\r|\n|\0/.test(trimmed)) throw new Error(`${label} contains invalid control characters`);
  return trimmed;
}

function throughArgs(through?: number | null): string[] {
  if (through == null) return [];
  if (!Number.isSafeInteger(through) || through < 0) {
    throw new Error('StoryOS timeline boundary must be a non-negative safe integer');
  }
  return ['--through', String(through)];
}

function requireEntityId(entityId: string): string {
  const value = requireNonEmpty(entityId, 'StoryOS entity ID');
  if (!ENTITY_ID_RE.test(value)) throw new Error('StoryOS entity ID has an invalid typed-ID format');
  return value;
}

function requireRelativeManuscriptPath(relativePath: string): string {
  const value = requireNonEmpty(relativePath, 'StoryOS manuscript path');
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\')) {
    throw new Error('StoryOS manuscript path must be project-relative');
  }
  const parts = value.split(/[\\/]+/);
  if (parts.some((part) => part === '..')) {
    throw new Error('StoryOS manuscript path cannot escape the manuscript root');
  }
  return value;
}

async function executeReadOnly(args: string[]): Promise<unknown> {
  const output = await invoke<ShellExecuteOutput>('plugin:shell|execute', {
    program: STORYOS_SIDECAR,
    args,
    options: { sidecar: true },
  });
  if (output.code !== 0) {
    const detail = (output.stderr || output.stdout || `exit code ${String(output.code)}`).trim();
    throw new Error(`StoryOS workspace sidecar failed: ${detail.slice(0, MAX_ERROR_CHARS)}`);
  }
  try {
    return JSON.parse(output.stdout);
  } catch (error) {
    throw new Error(`StoryOS workspace sidecar returned invalid JSON: ${String(error)}`);
  }
}

function assertSchema<T>(value: unknown, schema: string): T {
  if (typeof value !== 'object' || value === null || (value as { schema?: unknown }).schema !== schema) {
    throw new Error(`StoryOS workspace response schema mismatch; expected ${schema}`);
  }
  return value as T;
}

export async function loadStoryOsWorkspace(
  projectPath: string,
  through?: number | null,
): Promise<StoryOsWorkspaceSnapshot> {
  const payload = await executeReadOnly([
    'snapshot',
    requireNonEmpty(projectPath, 'StoryOS project path'),
    ...throughArgs(through),
  ]);
  return assertSchema<StoryOsWorkspaceSnapshot>(payload, 'story.authoring-workspace.v1');
}

export async function loadStoryOsEntity(
  projectPath: string,
  entityId: string,
  through?: number | null,
): Promise<StoryOsEntityView> {
  const payload = await executeReadOnly([
    'entity',
    requireNonEmpty(projectPath, 'StoryOS project path'),
    requireEntityId(entityId),
    ...throughArgs(through),
  ]);
  return assertSchema<StoryOsEntityView>(payload, 'story.authoring-entity.v1');
}

export async function loadStoryOsManuscript(
  projectPath: string,
  relativePath: string,
): Promise<StoryOsManuscriptView> {
  const payload = await executeReadOnly([
    'manuscript',
    requireNonEmpty(projectPath, 'StoryOS project path'),
    requireRelativeManuscriptPath(relativePath),
  ]);
  return assertSchema<StoryOsManuscriptView>(payload, 'story.authoring-manuscript.v1');
}
