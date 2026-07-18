import { useState, type CSSProperties } from 'react';
import {
  Crosshair,
  Layers3,
  Pause,
  Play,
  Rotate3D,
  ScanLine,
  Sun,
  SunMedium,
} from 'lucide-react';
import { renderPlatformIcon } from '../utils/platformMeta';
import type { PlatformId } from '../types/platform';
import type { ModelEmblemKind } from './ModelGeometricEmblem';
import { WebGLGeometricCore } from './WebGLGeometricCore';
import { useModelRotation } from '../hooks/useModelRotation';

interface SpatialCommandHeroProps {
  totalAccounts: number;
  activePlatforms: number;
  initialModelId?: string;
}

const AI_MODELS: Array<{ id: ModelEmblemKind; label: string; platform: PlatformId }> = [
  { id: 'gpt', label: 'GPT', platform: 'codex' },
  { id: 'claude', label: 'Claude', platform: 'claude_manager' },
  { id: 'codex', label: 'Codex', platform: 'codex' },
  { id: 'gemini', label: 'Gemini', platform: 'gemini' },
  { id: 'antigravity', label: 'Antigravity', platform: 'antigravity' },
  { id: 'github', label: 'Copilot', platform: 'github-copilot' },
];
const AI_MODEL_IDS = AI_MODELS.map((model) => model.id);

const LIGHT_MODES = [
  { id: 'spot', label: 'Spot', labelZh: '聚光', icon: SunMedium },
  { id: 'area', label: 'Area', labelZh: '区域', icon: ScanLine },
  { id: 'target', label: 'Target', labelZh: '目标', icon: Crosshair },
  { id: 'sun', label: 'Sun', labelZh: '日光', icon: Sun },
] as const;

export function SpatialCommandHero({ initialModelId }: SpatialCommandHeroProps) {
  const [mode, setMode] = useState<'render' | 'rotation' | 'texture'>('texture');
  const [lightMode, setLightMode] = useState<(typeof LIGHT_MODES)[number]['id']>('spot');
  const [intensity, setIntensity] = useState(62);
  const [shadow, setShadow] = useState(34);
  const [rotationSpeed, setRotationSpeed] = useState(35);
  const [paused, setPaused] = useState(false);
  const initialModel = AI_MODEL_IDS.find((model) => model === initialModelId) ?? AI_MODEL_IDS[0];
  const {
    activeItem,
    activeIndex: activeModelIndex,
    selectItem,
  } = useModelRotation({
    items: AI_MODEL_IDS,
    initialItem: initialModel,
    intervalMs: 9200,
    manualResumeMs: 12500,
    paused,
  });
  const activeModel = AI_MODELS[activeModelIndex];
  const activeLight = LIGHT_MODES.find((item) => item.id === lightMode) ?? LIGHT_MODES[0];
  const activeModeLabel = mode === 'render' ? '渲染光效 / RENDER' : mode === 'texture' ? '材质映射 / TEXTURE' : '自动旋转 / ROTATION';

  return (
    <section
      className={`spatial-command-hero spatial-mode-${mode} spatial-light-${lightMode}${paused ? ' spatial-paused' : ''}`}
      style={{
        '--core-intensity': intensity / 100,
        '--shadow-density': shadow / 100,
        '--studio-rotation-duration': `${Math.max(5, 25 - rotationSpeed * 0.35)}s`,
        '--studio-speed-ratio': (rotationSpeed - 12) / 48,
      } as CSSProperties}
    >
      <aside className="spatial-tool-palette">
        <div className="spatial-palette-group spatial-model-group">
          <label><span>模型</span><small>MODELS</small></label>
          <div className="spatial-model-list">
            {AI_MODELS.map((model, index) => (
              <button
                type="button"
                key={model.id}
                className={index === activeModelIndex ? 'active' : ''}
                onClick={() => selectItem(model.id)}
                aria-pressed={index === activeModelIndex}
                aria-label={`选择 ${model.label} 模型 / Select ${model.label}`}
                title={model.label}
              >
                {renderPlatformIcon(model.platform, 17)}
                <span>{model.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="spatial-palette-group spatial-tools-group">
          <label><span>工具</span><small>TOOLS</small></label>
          <button type="button" className={mode === 'render' ? 'active' : ''} onClick={() => setMode('render')} aria-pressed={mode === 'render'} aria-label="渲染模式 / Render mode">
            <SunMedium size={17} /><span><b>渲染</b><small>RENDER</small></span>
          </button>
          <button type="button" className={mode === 'rotation' ? 'active' : ''} onClick={() => setMode('rotation')} aria-pressed={mode === 'rotation'} aria-label="旋转模式 / Rotation mode">
            <Rotate3D size={17} /><span><b>旋转</b><small>ROTATE</small></span>
          </button>
          <button type="button" className={mode === 'texture' ? 'active' : ''} onClick={() => setMode('texture')} aria-pressed={mode === 'texture'} aria-label="材质模式 / Texture mode">
            <Layers3 size={17} /><span><b>材质</b><small>TEXTURE</small></span>
          </button>
        </div>
      </aside>

      <div className={`spatial-core-stage ai-model-stage model-${activeModel.id}`}>
        <div className="spatial-orbit spatial-orbit-outer"><span /><span /><span /></div>
        <div className="spatial-orbit spatial-orbit-inner" />
        <button
          type="button"
          className="ai-emblem-wrap"
          onClick={() => setPaused((value) => !value)}
          aria-pressed={paused}
          aria-label={paused ? '继续模型动态 / Resume model' : '暂停模型动态 / Pause model'}
        >
          <div className="ai-emblem">
            <WebGLGeometricCore
              variant={activeItem}
              className={`webgl-model-${activeModel.id}`}
              ariaLabel={`${activeModel.label} 交互式三维模型 / Interactive 3D model`}
              paused={paused}
              intensity={intensity}
              shadow={shadow}
              lightMode={lightMode}
              mode={mode}
              rotationSpeed={rotationSpeed / 24}
            />
          </div>
        </button>
        <div className="ai-model-caption"><strong>{activeModel.label}</strong></div>
        <div className="spatial-core-shadow" />
        <div className="spatial-rotation-readout">
          <span>{mode === 'rotation' ? '转速 / ROTATION' : mode === 'render' ? '光能 / OUTPUT' : '材质 / MATERIAL'}</span>
          <strong>{mode === 'rotation' ? `${rotationSpeed}°` : mode === 'render' ? `${intensity}%` : '01'}</strong>
        </div>
        <div className="spatial-axis"><i>X</i><i>Y</i><i>Z</i></div>
        <button
          type="button"
          className="spatial-pause-button"
          onClick={() => setPaused((value) => !value)}
          aria-pressed={paused}
          aria-label={paused ? '继续模型动态 / Resume motion' : '暂停模型动态 / Pause motion'}
          title={paused ? '继续 / Resume' : '暂停 / Pause'}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </button>
      </div>

      <aside className="spatial-light-dock">
        <label><span>光照</span><small>LIGHTING</small></label>
        <div className="spatial-light-modes">
          {LIGHT_MODES.map(({ id, label, labelZh, icon: Icon }) => (
            <button
              type="button"
              key={id}
              className={lightMode === id ? 'active' : ''}
              onClick={() => setLightMode(id)}
              aria-pressed={lightMode === id}
              aria-label={`${labelZh}光照 / ${label}`}
            >
              <Icon size={15} /><span><b>{labelZh}</b><small>{label.toUpperCase()}</small></span>
            </button>
          ))}
        </div>
        <div className="spatial-slider-control">
          <div><span>亮度 <small>/ BRIGHTNESS</small></span><strong>{intensity}</strong></div>
          <input aria-label="亮度 / Brightness" type="range" min="20" max="100" value={intensity} onChange={(event) => setIntensity(Number(event.target.value))} />
        </div>
        <div className="spatial-slider-control spatial-shadow-control">
          <div><span>阴影 <small>/ SHADOW</small></span><strong>{shadow}</strong></div>
          <input aria-label="阴影密度 / Shadow density" type="range" min="0" max="90" value={shadow} onChange={(event) => setShadow(Number(event.target.value))} />
        </div>
        {mode === 'rotation' && (
          <div className="spatial-slider-control spatial-rotation-control">
            <div><span>转速 <small>/ SPEED</small></span><strong>{rotationSpeed}°/s</strong></div>
            <input aria-label="旋转速度 / Rotation speed" type="range" min="12" max="60" value={rotationSpeed} onChange={(event) => setRotationSpeed(Number(event.target.value))} />
          </div>
        )}
        <div className="spatial-control-feedback" role="status" aria-live="polite">
          <i aria-hidden="true" />
          <span>{paused ? '动态已暂停 / PAUSED' : activeModeLabel}</span>
          <b>{activeLight.labelZh} / {activeLight.label.toUpperCase()}</b>
        </div>
      </aside>

      <span className="spatial-hero-index">{String(activeModelIndex + 1).padStart(3, '0')}</span>
    </section>
  );
}
