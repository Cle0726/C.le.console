import { useId } from 'react';

export type ModelEmblemKind =
  | 'gpt'
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'antigravity'
  | 'github';

interface ModelGeometricEmblemProps {
  kind: ModelEmblemKind;
}

function SharedDefs({ uid }: { uid: string }) {
  return (
    <defs>
      <linearGradient id={`${uid}-silver`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#f6f8f8" />
        <stop offset="0.45" stopColor="#c9d0d3" />
        <stop offset="1" stopColor="#778187" />
      </linearGradient>
      <linearGradient id={`${uid}-graphite`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#31383c" />
        <stop offset="1" stopColor="#090c0e" />
      </linearGradient>
      <linearGradient id={`${uid}-ice`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#eef3f4" />
        <stop offset="1" stopColor="#aab8bf" />
      </linearGradient>
      <filter id={`${uid}-shadow`} x="-40%" y="-40%" width="180%" height="200%">
        <feDropShadow dx="0" dy="12" stdDeviation="8" floodColor="#101619" floodOpacity=".24" />
      </filter>
    </defs>
  );
}

function GptEmblem({ uid }: { uid: string }) {
  const rotations = [0, 60, 120, 180, 240, 300];

  return (
    <>
      <g className="emblem-wire emblem-wire-gpt">
        <polygon points="120,20 192,61 192,145 120,187 48,145 48,61" />
        <circle cx="120" cy="103" r="66" />
      </g>
      <g className="emblem-gpt-knot" filter={`url(#${uid}-shadow)`}>
        {rotations.map((rotation) => (
          <path
            key={rotation}
            transform={`rotate(${rotation} 120 104)`}
            d="M120 36 148 52 148 93 132 102 132 67 120 60 108 67 108 98 82 83 82 53 108 38Z"
            fill={`url(#${uid}-${rotation % 120 === 0 ? 'graphite' : 'silver'})`}
          />
        ))}
        <polygon className="emblem-core-light" points="120,79 142,92 142,117 120,130 98,117 98,92" />
        <polygon className="emblem-core-line" points="120,88 134,96 134,112 120,120 106,112 106,96" />
      </g>
    </>
  );
}

function ClaudeEmblem({ uid }: { uid: string }) {
  return (
    <>
      <g className="emblem-wire emblem-wire-claude">
        <path d="M41 131C60 46 157 14 205 75" />
        <path d="M35 146C83 203 178 198 207 117" />
        <path d="M63 45 196 163M40 110l162 4" />
      </g>
      <g className="emblem-claude-crown" filter={`url(#${uid}-shadow)`}>
        <polygon points="120,31 142,85 120,105 98,85" fill={`url(#${uid}-silver)`} />
        <polygon points="178,54 157,106 129,108 139,79" fill={`url(#${uid}-graphite)`} />
        <polygon points="201,113 148,128 128,108 159,101" fill={`url(#${uid}-silver)`} />
        <polygon points="171,170 129,136 130,108 151,132" fill={`url(#${uid}-graphite)`} />
        <polygon points="105,184 104,129 126,110 128,142" fill={`url(#${uid}-silver)`} />
        <polygon points="52,145 100,118 126,108 100,139" fill={`url(#${uid}-graphite)`} />
        <polygon points="48,78 103,89 125,106 92,101" fill={`url(#${uid}-silver)`} />
        <polygon className="emblem-core-dark" points="120,82 145,102 136,132 104,132 95,102" />
        <circle className="emblem-core-light" cx="120" cy="108" r="8" />
      </g>
    </>
  );
}

function CodexEmblem({ uid }: { uid: string }) {
  return (
    <>
      <g className="emblem-wire emblem-wire-codex">
        <path d="M45 67 112 28l78 42-1 90-67 39-77-43Z" />
        <path d="m45 67 77 42 68-39M122 109v90" />
        <path d="m62 173 60-35 52 28" />
      </g>
      <g className="emblem-codex-shell" filter={`url(#${uid}-shadow)`}>
        <polygon points="120,48 180,82 180,148 120,182 60,148 60,82" fill={`url(#${uid}-graphite)`} />
        <polygon points="120,48 180,82 120,116 60,82" fill={`url(#${uid}-silver)`} />
        <polygon className="emblem-codex-face" points="120,116 180,82 180,148 120,182" />
        <polygon className="emblem-codex-window" points="83,90 157,90 157,140 83,140" />
        <path className="emblem-codex-command" d="m101 104-13 11 13 11m18 3 14-28" />
        <path className="emblem-codex-ridge" d="M120 48v28m0 106v-34" />
      </g>
    </>
  );
}

function GeminiEmblem({ uid }: { uid: string }) {
  return (
    <>
      <g className="emblem-wire emblem-wire-gemini">
        <ellipse cx="120" cy="108" rx="91" ry="39" />
        <ellipse cx="120" cy="108" rx="39" ry="91" />
        <path d="M25 108h190M120 13v190" />
      </g>
      <g className="emblem-gemini-prism" filter={`url(#${uid}-shadow)`}>
        <polygon points="120,23 139,87 203,108 139,129 120,193 101,129 37,108 101,87" fill={`url(#${uid}-silver)`} />
        <polygon points="120,23 120,108 203,108 139,87" fill={`url(#${uid}-ice)`} />
        <polygon points="203,108 120,108 120,193 139,129" fill={`url(#${uid}-graphite)`} />
        <polygon className="emblem-core-dark" points="120,72 132,96 156,108 132,120 120,144 108,120 84,108 108,96" />
        <circle className="emblem-gemini-node" cx="120" cy="108" r="5" />
      </g>
    </>
  );
}

function AntigravityEmblem({ uid }: { uid: string }) {
  return (
    <>
      <g className="emblem-antigravity-orbits">
        <ellipse cx="120" cy="104" rx="91" ry="37" />
        <ellipse cx="120" cy="104" rx="91" ry="37" transform="rotate(58 120 104)" />
        <ellipse cx="120" cy="104" rx="91" ry="37" transform="rotate(118 120 104)" />
        <circle cx="38" cy="104" r="4" />
        <circle cx="164" cy="31" r="3" />
        <circle cx="171" cy="171" r="4" />
      </g>
      <g className="emblem-antigravity-core" filter={`url(#${uid}-shadow)`}>
        <polygon points="120,45 162,82 148,138 120,166 92,138 78,82" fill={`url(#${uid}-graphite)`} />
        <polygon points="120,45 120,110 162,82" fill={`url(#${uid}-silver)`} />
        <polygon points="120,45 78,82 120,110" fill={`url(#${uid}-ice)`} />
        <polygon className="emblem-antigravity-cut" points="120,110 148,138 120,166 92,138" />
        <circle className="emblem-antigravity-center" cx="120" cy="110" r="8" />
      </g>
      <g className="emblem-antigravity-base">
        <ellipse cx="120" cy="200" rx="49" ry="10" />
        <path d="M90 198h60" />
      </g>
    </>
  );
}

function CopilotEmblem({ uid }: { uid: string }) {
  return (
    <>
      <g className="emblem-wire emblem-wire-copilot">
        <path d="M28 82 62 46h116l34 36v78l-30 26H58l-30-26Z" />
        <path d="m28 82 32 21m152-21-32 21M62 46l20 31m96-31-20 31" />
      </g>
      <g className="emblem-copilot-shell" filter={`url(#${uid}-shadow)`}>
        <path d="M48 85 74 66h92l26 19v59l-26 23H74l-26-23Z" fill={`url(#${uid}-graphite)`} />
        <path d="M48 85 74 66h92l26 19-27 21H75Z" fill={`url(#${uid}-silver)`} />
        <path className="emblem-copilot-bridge" d="M101 108c8-12 30-12 38 0v28h-38Z" />
        <g className="emblem-copilot-lens">
          <polygon points="65,99 101,105 101,143 65,151" />
          <polygon points="139,105 175,99 175,151 139,143" />
          <circle cx="84" cy="124" r="10" />
          <circle cx="156" cy="124" r="10" />
        </g>
        <path className="emblem-copilot-axis" d="M84 111v26m72-26v26" />
      </g>
    </>
  );
}

export function ModelGeometricEmblem({ kind }: ModelGeometricEmblemProps) {
  const uid = useId().replace(/:/g, '');

  return (
    <svg
      className={`model-geometric-emblem emblem-${kind}`}
      viewBox="0 0 240 220"
      aria-hidden="true"
      focusable="false"
    >
      <SharedDefs uid={uid} />
      <ellipse className="model-emblem-shadow" cx="120" cy="201" rx="68" ry="11" />
      {kind === 'gpt' && <GptEmblem uid={uid} />}
      {kind === 'claude' && <ClaudeEmblem uid={uid} />}
      {kind === 'codex' && <CodexEmblem uid={uid} />}
      {kind === 'gemini' && <GeminiEmblem uid={uid} />}
      {kind === 'antigravity' && <AntigravityEmblem uid={uid} />}
      {kind === 'github' && <CopilotEmblem uid={uid} />}
    </svg>
  );
}
