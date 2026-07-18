export function GeometricModelCore() {
  return (
    <svg className="geometric-model-core" viewBox="0 0 420 420" role="presentation">
      <defs>
        <linearGradient id="facet-silver" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f0f2f2" />
          <stop offset="1" stopColor="#889197" />
        </linearGradient>
        <linearGradient id="facet-graphite" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#353b3f" />
          <stop offset="1" stopColor="#0e1113" />
        </linearGradient>
        <filter id="core-shadow" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="18" stdDeviation="13" floodColor="#111619" floodOpacity=".24" />
        </filter>
      </defs>

      <ellipse className="geometry-ground" cx="210" cy="334" rx="118" ry="22" />

      <g className="geometry-orbit-system">
        <ellipse className="geometry-orbit-ring geometry-orbit-ring-main" cx="210" cy="214" rx="190" ry="122" />
        <ellipse
          className="geometry-orbit-ring geometry-orbit-ring-cross"
          cx="210"
          cy="210"
          rx="178"
          ry="76"
          transform="rotate(-31 210 210)"
        />
        <path className="geometry-orbit-accent" d="M142 329C180 344 240 344 278 329" />
        <g className="geometry-orbit-nodes">
          <circle cx="22" cy="214" r="4" />
          <circle cx="372" cy="154" r="3.5" />
          <circle cx="330" cy="309" r="3" />
        </g>
        <path className="geometry-orbit-ticks" d="M16 198h18M386 228h18M202 82v-16M202 362v16" />
      </g>

      <g className="geometry-outer-wire">
        <path d="M210 34 302 72 366 150 366 250 302 330 210 370 118 330 54 250 54 150 118 72Z" />
        <path d="M210 34 366 250 118 330 118 72 366 150 210 370 54 150 302 72 302 330 54 250Z" />
      </g>

      <g className="geometry-offset-wire" transform="rotate(18 210 202)">
        <path d="M210 74 280 102 330 160 330 238 280 300 210 330 140 300 90 238 90 160 140 102Z" />
        <circle cx="210" cy="74" r="3" />
        <circle cx="330" cy="160" r="3" />
        <circle cx="280" cy="300" r="3" />
        <circle cx="140" cy="300" r="3" />
        <circle cx="90" cy="160" r="3" />
      </g>

      <g className="geometry-solid" filter="url(#core-shadow)">
        <polygon className="facet facet-northwest" points="210,84 210,201 100,201" />
        <polygon className="facet facet-northeast" points="210,84 320,201 210,201" />
        <polygon className="facet facet-southeast" points="320,201 210,318 210,201" />
        <polygon className="facet facet-southwest" points="210,318 100,201 210,201" />
        <polygon className="facet-cut" points="210,158 252,201 210,244 168,201" />
        <path className="facet-axis" d="M210 84V318M100 201h220" />
      </g>

      <g className="geometry-core-mark">
        <circle cx="210" cy="201" r="10" />
        <circle cx="210" cy="201" r="21" />
      </g>
    </svg>
  );
}
