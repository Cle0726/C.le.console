import { useCallback, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  BookOpenText,
  ChevronLeft,
  Clock3,
  FileText,
  FolderOpen,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
} from 'lucide-react';
import {
  loadStoryOsEntity,
  loadStoryOsManuscript,
  loadStoryOsWorkspace,
  type StoryOsEntitySummary,
  type StoryOsEntityView,
  type StoryOsManuscriptSummary,
  type StoryOsManuscriptView,
  type StoryOsWorkspaceSnapshot,
} from '../services/storyosBridge';
import './StoryOSWorkspacePage.css';

type LibraryMode = 'manuscripts' | 'characters';

interface StoryOSWorkspacePageProps {
  onExit: () => void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readableValue(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value || '—';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function manuscriptEyebrow(item: StoryOsManuscriptSummary | StoryOsManuscriptView): string {
  const parts: string[] = [];
  if (item.season != null) parts.push(`S${String(item.season).padStart(2, '0')}`);
  if (item.episode != null) parts.push(`EP${String(item.episode).padStart(2, '0')}`);
  return parts.join(' · ') || 'MANUSCRIPT';
}

function parseThrough(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('时间边界必须是非负整数；留空表示读取最新状态。');
  }
  return parsed;
}

function workflowSummary(snapshot: StoryOsWorkspaceSnapshot | null) {
  if (!snapshot) return { attention: {}, review: {}, materialization: {}, commit: {} };
  const workflow = asRecord(snapshot.workflow);
  return {
    attention: asRecord(workflow.attention),
    review: asRecord(workflow.review),
    materialization: asRecord(workflow.materialization),
    commit: asRecord(workflow.canon_commit),
  };
}

export function StoryOSWorkspacePage({ onExit }: StoryOSWorkspacePageProps) {
  const [projectPath, setProjectPath] = useState('');
  const [workspace, setWorkspace] = useState<StoryOsWorkspaceSnapshot | null>(null);
  const [throughDraft, setThroughDraft] = useState('');
  const [libraryMode, setLibraryMode] = useState<LibraryMode>('manuscripts');
  const [query, setQuery] = useState('');
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [error, setError] = useState('');
  const [manuscript, setManuscript] = useState<StoryOsManuscriptView | null>(null);
  const [entityView, setEntityView] = useState<StoryOsEntityView | null>(null);
  const [selectedManuscriptPath, setSelectedManuscriptPath] = useState<string | null>(null);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);

  const workflow = useMemo(() => workflowSummary(workspace), [workspace]);

  const characters = useMemo(
    () => (workspace?.entities ?? []).filter((entity) => entity.kind === 'character'),
    [workspace],
  );

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredManuscripts = useMemo(
    () => (workspace?.manuscripts ?? []).filter((item) => {
      if (!normalizedQuery) return true;
      return `${item.title} ${item.name} ${item.path}`.toLocaleLowerCase().includes(normalizedQuery);
    }),
    [normalizedQuery, workspace],
  );
  const filteredCharacters = useMemo(
    () => characters.filter((item) => {
      if (!normalizedQuery) return true;
      return `${item.name} ${item.slug} ${item.aliases.join(' ')}`.toLocaleLowerCase().includes(normalizedQuery);
    }),
    [characters, normalizedQuery],
  );

  const loadWorkspace = useCallback(async (path: string, throughValue: string) => {
    setWorkspaceBusy(true);
    setError('');
    try {
      const through = parseThrough(throughValue);
      const next = await loadStoryOsWorkspace(path, through);
      setWorkspace(next);
      setProjectPath(path);
      setManuscript(null);
      setEntityView(null);
      setSelectedManuscriptPath(null);
      setSelectedEntityId(null);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setWorkspaceBusy(false);
    }
  }, []);

  const chooseProject = useCallback(async () => {
    setError('');
    try {
      const selected = await open({
        title: '选择 C.le. StoryOS 项目目录',
        directory: true,
        multiple: false,
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;
      setThroughDraft('');
      await loadWorkspace(path, '');
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }, [loadWorkspace]);

  const refreshWorkspace = useCallback(async () => {
    if (!projectPath) return;
    await loadWorkspace(projectPath, throughDraft);
  }, [loadWorkspace, projectPath, throughDraft]);

  const selectManuscript = useCallback(async (item: StoryOsManuscriptSummary) => {
    if (!projectPath) return;
    setDetailBusy(true);
    setError('');
    setSelectedManuscriptPath(item.path);
    try {
      const next = await loadStoryOsManuscript(projectPath, item.path);
      setManuscript(next);
    } catch (cause) {
      setSelectedManuscriptPath(null);
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setDetailBusy(false);
    }
  }, [projectPath]);

  const selectEntity = useCallback(async (item: StoryOsEntitySummary) => {
    if (!projectPath) return;
    setDetailBusy(true);
    setError('');
    setSelectedEntityId(item.id);
    try {
      const through = parseThrough(throughDraft);
      const next = await loadStoryOsEntity(projectPath, item.id, through);
      setEntityView(next);
    } catch (cause) {
      setSelectedEntityId(null);
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setDetailBusy(false);
    }
  }, [projectPath, throughDraft]);

  const summary = workspace?.summary ?? {};
  const effectiveSequence = workspace?.timeline.effective_through_sequence;
  const latestSequence = workspace?.timeline.latest_event_sequence;
  const referenceErrors = workspace?.diagnostics.reference_errors ?? [];

  return (
    <section className="storyos-workspace" aria-label="C.le. StoryOS 只读创作工作台">
      <header className="storyos-workspace-header">
        <div className="storyos-workspace-brand">
          <button className="storyos-back-button" type="button" onClick={onExit} title="返回 C.le.控制台">
            <ChevronLeft size={18} />
          </button>
          <div>
            <div className="storyos-brand-line">
              <span className="storyos-wordmark">C.le. StoryOS</span>
              <span className="storyos-readonly-badge"><ShieldCheck size={12} />只读工作台</span>
            </div>
            <div className="storyos-project-line">
              {workspace ? workspace.project.name || '未命名项目' : '长期小说续写与连续性管理'}
              {projectPath ? <span title={projectPath}>{projectPath}</span> : null}
            </div>
          </div>
        </div>

        <div className="storyos-header-actions">
          {workspace ? (
            <label className="storyos-through-control" title="留空表示最新 Story State">
              <Clock3 size={14} />
              <span>状态截至</span>
              <input
                value={throughDraft}
                onChange={(event) => setThroughDraft(event.target.value.replace(/[^0-9]/g, ''))}
                placeholder="最新"
                inputMode="numeric"
                disabled={workspaceBusy}
              />
            </label>
          ) : null}
          <button
            type="button"
            className="storyos-button storyos-button-secondary"
            onClick={workspace ? refreshWorkspace : chooseProject}
            disabled={workspaceBusy}
          >
            {workspace ? <RefreshCw size={15} className={workspaceBusy ? 'storyos-spin' : undefined} /> : <FolderOpen size={15} />}
            {workspace ? '刷新' : '打开项目'}
          </button>
          {workspace ? (
            <button type="button" className="storyos-button storyos-button-primary" onClick={chooseProject} disabled={workspaceBusy}>
              <FolderOpen size={15} />切换项目
            </button>
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="storyos-error" role="alert">
          <strong>StoryOS 无法完成读取</strong>
          <span>{error}</span>
        </div>
      ) : null}

      {!workspace ? (
        <div className="storyos-empty-stage">
          <div className="storyos-empty-mark"><BookOpenText size={34} /></div>
          <p className="storyos-kicker">LONG-FORM STORY OPERATING SYSTEM</p>
          <h1>让正文、Canon 与 Story State 分开管理。</h1>
          <p>
            选择一个 StoryOS 项目目录后，可以读取正文索引、人物当前状态、Canon 数量、审核队列与时间边界。
            这一版不会写入正文，也不会提交 Canon。
          </p>
          <button type="button" className="storyos-button storyos-button-primary storyos-empty-action" onClick={chooseProject} disabled={workspaceBusy}>
            <FolderOpen size={17} />{workspaceBusy ? '读取项目…' : '选择 StoryOS 项目'}
          </button>
        </div>
      ) : (
        <>
          <div className="storyos-summary-strip">
            <div><span>正文</span><strong>{asNumber(summary.manuscripts)}</strong></div>
            <div><span>人物</span><strong>{asNumber(summary.characters)}</strong></div>
            <div><span>实体</span><strong>{asNumber(summary.entities)}</strong></div>
            <div><span>Canon</span><strong>{asNumber(summary.active_canon_facts)}</strong></div>
            <div><span>Claims</span><strong>{asNumber(summary.claims)}</strong></div>
            <div className={referenceErrors.length > 0 ? 'storyos-summary-alert' : ''}>
              <span>引用错误</span><strong>{referenceErrors.length}</strong>
            </div>
            <div className="storyos-summary-timeline">
              <span>Story State</span>
              <strong>{effectiveSequence == null ? '—' : `#${effectiveSequence}`}</strong>
              {latestSequence != null && effectiveSequence !== latestSequence ? <small>最新 #{latestSequence}</small> : null}
            </div>
          </div>

          <div className="storyos-workspace-grid">
            <aside className="storyos-library-panel">
              <div className="storyos-segmented">
                <button type="button" className={libraryMode === 'manuscripts' ? 'active' : ''} onClick={() => setLibraryMode('manuscripts')}>
                  <FileText size={14} />正文
                </button>
                <button type="button" className={libraryMode === 'characters' ? 'active' : ''} onClick={() => setLibraryMode('characters')}>
                  <Users size={14} />人物
                </button>
              </div>
              <label className="storyos-search">
                <Search size={14} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={libraryMode === 'manuscripts' ? '搜索章节…' : '搜索人物…'}
                />
              </label>

              <div className="storyos-library-list">
                {libraryMode === 'manuscripts' ? filteredManuscripts.map((item) => (
                  <button
                    type="button"
                    key={item.path}
                    className={`storyos-library-item${selectedManuscriptPath === item.path ? ' active' : ''}`}
                    onClick={() => void selectManuscript(item)}
                    disabled={detailBusy && selectedManuscriptPath !== item.path}
                  >
                    <span className="storyos-library-eyebrow">{manuscriptEyebrow(item)}</span>
                    <strong>{item.title || item.name}</strong>
                    <small>{item.characters.toLocaleString()} 字 · {formatBytes(item.bytes)}</small>
                  </button>
                )) : filteredCharacters.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={`storyos-library-item storyos-character-item${selectedEntityId === item.id ? ' active' : ''}`}
                    onClick={() => void selectEntity(item)}
                    disabled={detailBusy && selectedEntityId !== item.id}
                  >
                    <span className="storyos-avatar">{item.name.trim().charAt(0) || '?'}</span>
                    <span className="storyos-character-copy">
                      <strong>{item.name}</strong>
                      <small>{item.counts.events} 条状态事件 · {item.counts.active_canon_facts} 条有效 Canon</small>
                    </span>
                  </button>
                ))}
                {libraryMode === 'manuscripts' && filteredManuscripts.length === 0 ? <p className="storyos-list-empty">没有匹配的正文。</p> : null}
                {libraryMode === 'characters' && filteredCharacters.length === 0 ? <p className="storyos-list-empty">没有匹配的人物。</p> : null}
              </div>
            </aside>

            <main className="storyos-reading-panel">
              {detailBusy && !manuscript ? <div className="storyos-panel-loading">正在读取…</div> : null}
              {manuscript ? (
                <>
                  <div className="storyos-document-header">
                    <div>
                      <span>{manuscriptEyebrow(manuscript)}</span>
                      <h2>{manuscript.title}</h2>
                    </div>
                    <div className="storyos-document-meta">
                      <span>{manuscript.characters.toLocaleString()} 字</span>
                      <span>{manuscript.lines.toLocaleString()} 行</span>
                      <span>{formatBytes(manuscript.bytes)}</span>
                    </div>
                  </div>
                  <div className="storyos-document-path" title={manuscript.path}>{manuscript.path}</div>
                  <article className="storyos-manuscript-content">{manuscript.content}</article>
                </>
              ) : (
                <div className="storyos-project-overview">
                  <p className="storyos-kicker">PROJECT OVERVIEW</p>
                  <h2>{workspace.project.name || '未命名项目'}</h2>
                  <p className="storyos-overview-copy">
                    当前读取的是{effectiveSequence == null ? '项目最新可用状态' : `事件序列 #${effectiveSequence} 的世界状态`}。
                    点击左侧正文时只读取单个文件；点击人物时只读取该人物的状态、事件、Canon 与 Claim 详情。
                  </p>
                  <div className="storyos-overview-cards">
                    <div>
                      <span>语言</span>
                      <strong>{workspace.project.language || '—'}</strong>
                    </div>
                    <div>
                      <span>可见事件</span>
                      <strong>{workspace.timeline.events.toLocaleString()} / {workspace.timeline.events_total.toLocaleString()}</strong>
                    </div>
                    <div>
                      <span>有效 Canon</span>
                      <strong>{asNumber(summary.active_canon_facts).toLocaleString()}</strong>
                    </div>
                    <div>
                      <span>引用完整性</span>
                      <strong>{referenceErrors.length === 0 ? 'PASS' : `${referenceErrors.length} ERROR`}</strong>
                    </div>
                  </div>
                  <div className="storyos-policy-note">
                    <ShieldCheck size={16} />
                    <div>
                      <strong>当前桌面层没有 Canon 写权限。</strong>
                      <span>Review、Materialization 与 Canon Commit 仍由独立命令边界管理。</span>
                    </div>
                  </div>
                </div>
              )}
            </main>

            <aside className="storyos-inspector-panel">
              {entityView ? (
                <EntityInspector view={entityView} />
              ) : (
                <WorkflowInspector snapshot={workspace} workflow={workflow} />
              )}
            </aside>
          </div>
        </>
      )}
    </section>
  );
}

function EntityInspector({ view }: { view: StoryOsEntityView }) {
  const values = Object.entries(view.state.values);
  return (
    <div className="storyos-inspector-content">
      <div className="storyos-inspector-title">
        <span className="storyos-avatar storyos-avatar-large">{view.entity.name.trim().charAt(0) || '?'}</span>
        <div>
          <span>{view.entity.kind.toUpperCase()}</span>
          <h3>{view.entity.name}</h3>
          <small>{view.entity.id}</small>
        </div>
      </div>

      <InspectorSection title="当前 Story State">
        {values.length === 0 ? <p className="storyos-muted">当前边界没有投影状态。</p> : (
          <dl className="storyos-state-list">
            {values.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{readableValue(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </InspectorSection>

      <InspectorSection title="知识与剧情">
        <div className="storyos-mini-metrics">
          <div><span>Knowledge</span><strong>{view.state.knowledge.length}</strong></div>
          <div><span>Resolved plots</span><strong>{view.state.resolved_plots.length}</strong></div>
        </div>
      </InspectorSection>

      <InspectorSection title="连续性来源">
        <div className="storyos-mini-metrics">
          <div><span>Events</span><strong>{view.events.length}</strong></div>
          <div><span>Canon</span><strong>{view.canon_facts.length}</strong></div>
          <div><span>Claims</span><strong>{view.claims.length}</strong></div>
        </div>
      </InspectorSection>

      {view.entity.aliases.length > 0 ? (
        <InspectorSection title="别名">
          <div className="storyos-chip-list">{view.entity.aliases.map((alias) => <span key={alias}>{alias}</span>)}</div>
        </InspectorSection>
      ) : null}
    </div>
  );
}

function WorkflowInspector({
  snapshot,
  workflow,
}: {
  snapshot: StoryOsWorkspaceSnapshot;
  workflow: ReturnType<typeof workflowSummary>;
}) {
  const attentionItems = [
    ['未审 Claim', asNumber(workflow.attention.unreviewed_claims)],
    ['过期 Review', asNumber(workflow.attention.stale_reviews)],
    ['可 Materialize', asNumber(workflow.attention.materialization_ready)],
    ['可 Commit', asNumber(workflow.attention.canon_commit_ready)],
    ['引用错误', asNumber(workflow.attention.reference_errors)],
  ] as const;

  return (
    <div className="storyos-inspector-content">
      <div className="storyos-inspector-heading">
        <span>CONTEXT / WORKFLOW</span>
        <h3>项目检查器</h3>
      </div>

      <InspectorSection title="需要注意">
        <div className="storyos-attention-list">
          {attentionItems.map(([label, count]) => (
            <div key={label} className={count > 0 ? 'has-attention' : ''}>
              <span>{label}</span><strong>{count}</strong>
            </div>
          ))}
        </div>
      </InspectorSection>

      <InspectorSection title="Canon Authority">
        <div className="storyos-authority-list">
          {Object.entries(snapshot.canon.authorities).map(([authority, count]) => (
            <div key={authority}><span>{authority}</span><strong>{count}</strong></div>
          ))}
          {Object.keys(snapshot.canon.authorities).length === 0 ? <p className="storyos-muted">暂无 Canon。</p> : null}
        </div>
      </InspectorSection>

      <InspectorSection title="工作流摘要">
        <pre className="storyos-workflow-json">{JSON.stringify({
          review: workflow.review,
          materialization: workflow.materialization,
          canon_commit: workflow.commit,
        }, null, 2)}</pre>
      </InspectorSection>

      {snapshot.diagnostics.reference_errors.length > 0 ? (
        <InspectorSection title="引用错误">
          <ul className="storyos-reference-errors">
            {snapshot.diagnostics.reference_errors.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}
          </ul>
        </InspectorSection>
      ) : null}
    </div>
  );
}

function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="storyos-inspector-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}
