import { useEffect, useState, type FocusEvent as ReactFocusEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowLeft, ArrowUpRight, GaugeCircle, Network, Shuffle } from 'lucide-react';
import type { PlatformId } from '../types/platform';
import { ModelGeometricEmblem, type ModelEmblemKind } from './ModelGeometricEmblem';
import { WebGLGeometricCore } from './WebGLGeometricCore';
import { useModelRotation } from '../hooks/useModelRotation';

export type DashboardScene = 'landing' | 'models' | 'studio' | 'data' | 'egress';

export const SHOWCASE_MODELS: Array<{ id: ModelEmblemKind; label: string; platform: PlatformId; index: string }> = [
  { id: 'gpt', label: 'GPT', platform: 'codex', index: '01' },
  { id: 'claude', label: 'Claude', platform: 'claude_manager', index: '02' },
  { id: 'codex', label: 'Codex', platform: 'codex', index: '03' },
  { id: 'gemini', label: 'Gemini', platform: 'gemini', index: '04' },
  { id: 'antigravity', label: 'Antigravity', platform: 'antigravity', index: '05' },
  { id: 'github', label: 'Copilot', platform: 'github-copilot', index: '06' },
];
const SHOWCASE_MODEL_IDS = SHOWCASE_MODELS.map((model) => model.id);

function handleModelCardPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
  if (
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    document.documentElement.dataset.performanceMode === 'lite'
  ) return;

  const card = event.currentTarget;
  const bounds = card.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));

  card.style.setProperty('--tilt-x', `${(0.5 - y) * 7}deg`);
  card.style.setProperty('--tilt-y', `${(x - 0.5) * 8}deg`);
  card.style.setProperty('--parallax-x', `${(x - 0.5) * 12}px`);
  card.style.setProperty('--parallax-y', `${(y - 0.5) * 9}px`);
  card.style.setProperty('--pointer-x', `${x * 100}%`);
  card.style.setProperty('--pointer-y', `${y * 100}%`);
}

function resetModelCardPointer(event: ReactPointerEvent<HTMLButtonElement>) {
  const card = event.currentTarget;
  card.style.setProperty('--tilt-x', '0deg');
  card.style.setProperty('--tilt-y', '0deg');
  card.style.setProperty('--parallax-x', '0px');
  card.style.setProperty('--parallax-y', '0px');
  card.style.setProperty('--pointer-x', '50%');
  card.style.setProperty('--pointer-y', '50%');
}

function handleLaunchpadPointerMove(event: ReactPointerEvent<HTMLElement>) {
  if (
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    document.documentElement.dataset.performanceMode === 'lite'
  ) return;
  const card = event.currentTarget;
  const bounds = card.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
  card.style.setProperty('--launch-tilt-x', `${(0.5 - y) * 2.8}deg`);
  card.style.setProperty('--launch-tilt-y', `${(x - 0.5) * 3.6}deg`);
  card.style.setProperty('--launch-shift-x', `${(x - 0.5) * 18}px`);
  card.style.setProperty('--launch-shift-y', `${(y - 0.5) * 14}px`);
  card.style.setProperty('--launch-pointer-x', `${x * 100}%`);
  card.style.setProperty('--launch-pointer-y', `${y * 100}%`);
}

function resetLaunchpadPointer(event: ReactPointerEvent<HTMLElement>) {
  const card = event.currentTarget;
  card.style.setProperty('--launch-tilt-x', '0deg');
  card.style.setProperty('--launch-tilt-y', '0deg');
  card.style.setProperty('--launch-shift-x', '0px');
  card.style.setProperty('--launch-shift-y', '0px');
  card.style.setProperty('--launch-pointer-x', '56%');
  card.style.setProperty('--launch-pointer-y', '48%');
}

export function DashboardSceneHeader({
  title,
  englishTitle,
  index,
  onBack,
}: {
  title: string;
  englishTitle?: string;
  index: string;
  onBack?: () => void;
}) {
  return (
    <header className="scene-header">
      <div className="scene-header-title">
        {onBack ? <button type="button" onClick={onBack} aria-label="返回上一页 / Back" title="返回 / Back"><ArrowLeft size={16} /></button> : <span />}
        <div>
          <small>SECTION / {index}</small>
          <strong><span>{title}</span>{englishTitle && <em>{englishTitle}</em>}</strong>
        </div>
      </div>
      <span className="scene-header-index">{index}</span>
    </header>
  );
}

export function DashboardLaunchpad({
  modelCount,
  quotaPercent,
  quotaModelLabel,
  onOpenModels,
  onOpenData,
  onOpenEgress,
  onModelChange,
}: {
  modelCount: number;
  quotaPercent: number | null;
  quotaModelLabel: string;
  onOpenModels: () => void;
  onOpenData: () => void;
  onOpenEgress: () => void;
  onModelChange?: (modelId: ModelEmblemKind) => void;
}) {
  const [interactionPaused, setInteractionPaused] = useState(false);
  const {
    activeItem,
    activeIndex,
    selectItem,
    shuffleNow,
    environmentPaused,
  } = useModelRotation({
    items: SHOWCASE_MODEL_IDS,
    intervalMs: 9200,
    manualResumeMs: 12500,
    paused: interactionPaused,
  });
  const activeModel = SHOWCASE_MODELS[activeIndex] ?? SHOWCASE_MODELS[0];

  useEffect(() => {
    onModelChange?.(activeItem);
  }, [activeItem, onModelChange]);

  const handlePrimaryPointerLeave = (event: ReactPointerEvent<HTMLElement>) => {
    resetLaunchpadPointer(event);
    setInteractionPaused(false);
  };

  const handlePrimaryBlur = (event: ReactFocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setInteractionPaused(false);
    }
  };

  return (
    <main className="main-content dashboard-scene dashboard-launchpad fade-in">
      <DashboardSceneHeader title="控制中心" englishTitle="CONTROL CENTER" index="00" />
      <div className="launchpad-grid">
        <section
          className="launchpad-primary"
          onPointerMove={handleLaunchpadPointerMove}
          onPointerEnter={() => setInteractionPaused(true)}
          onPointerLeave={handlePrimaryPointerLeave}
          onPointerCancel={handlePrimaryPointerLeave}
          onFocusCapture={() => setInteractionPaused(true)}
          onBlurCapture={handlePrimaryBlur}
          data-model-variant={activeModel.id}
        >
          <button
            type="button"
            className="launchpad-primary-open"
            onClick={onOpenModels}
            aria-label="打开模型库 / Open model library"
          />
          <div className="launchpad-primary-copy">
            <span><b>模型矩阵</b><em>MODEL MATRIX / {String(modelCount).padStart(2, '0')}</em></span>
            <small><b>选择 · 浏览 · 控制</b><em>SELECT · VIEW · CONTROL</em></small>
          </div>
          <div className="launchpad-object" aria-hidden="true">
            <WebGLGeometricCore
              variant={activeModel.id}
              mode="texture"
              intensity={58}
              shadow={30}
              rotationSpeed={0.86}
            />
          </div>
          <div className="launchpad-model-switcher" aria-label="几何模型选择 / Geometry model selector">
            <div className="launchpad-model-readout" aria-live="polite">
              <span>{activeModel.index} / 06</span>
              <strong>{activeModel.label}</strong>
              <small>{environmentPaused ? 'MANUAL' : interactionPaused ? 'HOLD' : 'AUTO'}</small>
            </div>
            <div className="launchpad-model-tabs" role="tablist" aria-label="选择主页模型 / Select home model">
              {SHOWCASE_MODELS.map((model) => (
                <button
                  type="button"
                  role="tab"
                  key={model.id}
                  className={model.id === activeItem ? 'active' : ''}
                  aria-selected={model.id === activeItem}
                  aria-label={`${model.label} 几何模型 / ${model.label} geometry`}
                  title={model.label}
                  onClick={() => selectItem(model.id)}
                >
                  <span>{model.index}</span>
                </button>
              ))}
              <button
                type="button"
                className="launchpad-shuffle-button"
                onClick={shuffleNow}
                aria-label="随机切换模型 / Shuffle model"
                title="随机切换 / Shuffle"
              >
                <Shuffle size={13} />
              </button>
            </div>
          </div>
          <ArrowUpRight className="launchpad-arrow" aria-hidden="true" />
          <b>{activeModel.index.padStart(3, '0')}</b>
        </section>

        <div className="launchpad-secondary-stack">
          <button type="button" className="launchpad-secondary" onClick={onOpenData} aria-label={`查看 ${quotaModelLabel} 当前额度 / View current quota`}>
            <div><GaugeCircle size={19} /><span className="bilingual-control-label"><b>当前额度</b><small>CURRENT QUOTA</small></span></div>
            <strong className="launchpad-quota-value">
              <span>{quotaPercent == null ? '--' : Math.round(quotaPercent)}</span><sup>%</sup>
            </strong>
            <div className="launchpad-quota-track" aria-hidden="true">
              <i style={{ width: `${quotaPercent ?? 0}%` }} />
            </div>
            <small>{quotaModelLabel.toUpperCase()} · 剩余额度 / REMAINING</small>
            <ArrowUpRight size={17} />
          </button>
          <button type="button" className="launchpad-secondary launchpad-egress" onClick={onOpenEgress} aria-label="打开出口监测 / Open egress monitor">
            <div><Network size={19} /><span className="bilingual-control-label"><b>出口监测</b><small>EGRESS MONITOR</small></span></div>
            <span className="launchpad-egress-visual" aria-hidden="true">
              <svg viewBox="0 0 118 72">
                <path d="M8 16C32 16 35 35 58 35S83 16 108 16" />
                <path d="M8 53C31 53 37 35 58 35S83 53 108 53" />
                <circle cx="8" cy="16" r="3" /><circle cx="8" cy="53" r="3" />
                <rect x="52" y="29" width="12" height="12" />
                <circle className="launchpad-egress-node" cx="108" cy="35" r="8" />
                <circle cx="108" cy="35" r="3" />
              </svg>
              <span><b>FIXED</b><small>NODE MATCH</small></span>
            </span>
            <small>固定节点检查 / ROUTE CONSISTENCY</small>
            <ArrowUpRight size={17} />
          </button>
        </div>
      </div>
    </main>
  );
}

export function DashboardModelGallery({
  onBack,
  onSelect,
}: {
  onBack: () => void;
  onSelect: (modelId: string) => void;
}) {
  return (
    <main className="main-content dashboard-scene model-gallery-page fade-in">
      <DashboardSceneHeader title="模型库" englishTitle="MODEL LIBRARY" index="01" onBack={onBack} />
      <div className="model-gallery-grid">
        {SHOWCASE_MODELS.map((model) => (
          <button
            type="button"
            key={model.id}
            className={`model-gallery-card gallery-${model.id}`}
            onClick={() => onSelect(model.id)}
            onPointerMove={handleModelCardPointerMove}
            onPointerLeave={resetModelCardPointer}
            onPointerCancel={resetModelCardPointer}
            aria-label={`打开 ${model.label} 模型 / Open ${model.label}`}
          >
            <span className="model-gallery-number">{model.index}</span>
            <div className="model-gallery-object">
              <ModelGeometricEmblem kind={model.id} />
            </div>
            <div className="model-gallery-label"><strong>{model.label}</strong><small>打开模型 / OPEN</small></div>
            <ArrowUpRight className="model-gallery-open" size={18} />
          </button>
        ))}
      </div>
    </main>
  );
}
