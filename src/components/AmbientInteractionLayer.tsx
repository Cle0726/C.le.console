export function AmbientInteractionLayer({ enabled = true }: { enabled?: boolean }) {
  if (!enabled) return null;

  return (
    <div className="ambient-interaction-layer" aria-hidden="true">
      {/*
       * Shared SVG refraction kernels. A translucent pseudo-surface first
       * captures the real backdrop, then these filters bend it like a shallow
       * water lens. Keeping two shared kernels avoids per-control canvases and
       * additional WebGL contexts while WebView2 can still composite the
       * result on the GPU.
       */}
      <svg
        className="liquid-water-filter-defs"
        width="0"
        height="0"
        focusable="false"
        aria-hidden="true"
      >
        <defs>
          <filter
            id="cle-water-panel-refraction"
            x="-12%"
            y="-12%"
            width="124%"
            height="124%"
            colorInterpolationFilters="sRGB"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.007 0.021"
              numOctaves="2"
              seed="17"
              result="panelWaterNoise"
            />
            <feGaussianBlur
              in="panelWaterNoise"
              stdDeviation="0.42"
              result="panelWaterSoft"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="panelWaterSoft"
              scale="7.5"
              xChannelSelector="R"
              yChannelSelector="G"
              result="panelWaterBent"
            />
            <feSpecularLighting
              in="panelWaterSoft"
              surfaceScale="1.8"
              specularConstant="0.34"
              specularExponent="24"
              lightingColor="#dcecf7"
              result="panelWaterLight"
            >
              <feDistantLight azimuth="218" elevation="54" />
            </feSpecularLighting>
            <feComposite
              in="panelWaterLight"
              in2="SourceAlpha"
              operator="in"
              result="panelWaterMaskedLight"
            />
            <feBlend
              in="panelWaterBent"
              in2="panelWaterMaskedLight"
              mode="screen"
            />
          </filter>

          <filter
            id="cle-water-control-refraction"
            x="-18%"
            y="-28%"
            width="136%"
            height="156%"
            colorInterpolationFilters="sRGB"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.018 0.052"
              numOctaves="2"
              seed="29"
              result="controlWaterNoise"
            />
            <feGaussianBlur
              in="controlWaterNoise"
              stdDeviation="0.32"
              result="controlWaterSoft"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="controlWaterSoft"
              scale="4.8"
              xChannelSelector="R"
              yChannelSelector="G"
              result="controlWaterBent"
            />
            <feSpecularLighting
              in="controlWaterSoft"
              surfaceScale="2.2"
              specularConstant="0.42"
              specularExponent="28"
              lightingColor="#e8f4fb"
              result="controlWaterLight"
            >
              <feDistantLight azimuth="224" elevation="58" />
            </feSpecularLighting>
            <feComposite
              in="controlWaterLight"
              in2="SourceAlpha"
              operator="in"
              result="controlWaterMaskedLight"
            />
            <feBlend
              in="controlWaterBent"
              in2="controlWaterMaskedLight"
              mode="screen"
            />
          </filter>
        </defs>
      </svg>
      <div className="ambient-depth">
        <div className="ambient-grid" />
        <div className="ambient-caustic" />
        <div className="ambient-prism ambient-prism-a" />
        <div className="ambient-prism ambient-prism-b" />
        <div className="ambient-beam ambient-beam-a" />
        <div className="ambient-beam ambient-beam-b" />
        <div className="ambient-beam ambient-beam-c" />
        <div className="ambient-specks" />
      </div>
      <div className="ambient-grain" />
    </div>
  );
}
