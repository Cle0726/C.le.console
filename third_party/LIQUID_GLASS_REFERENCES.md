# Liquid Glass implementation references

The C.le. control material is implemented locally with CSS compositing, a
generated rounded-rectangle SDF displacement map, and shared inline SVG
filters. No runtime code or remote asset is loaded from the references below.

Design and implementation references:

- Apple Human Interface Guidelines - Materials:
  https://developer.apple.com/design/human-interface-guidelines/materials
- Apple WWDC25 - Meet Liquid Glass:
  https://developer.apple.com/videos/play/wwdc2025/219/
- MDN - `backdrop-filter`:
  https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter
- `rdev/liquid-glass-react` (MIT): edge-only displacement, approximately
  6 px blur, 140% saturation, restrained chromatic aberration, and elastic
  pointer response:
  https://github.com/rdev/liquid-glass-react

Applied control parameters:

- edge-only displacement: R/G/B scales `44 / 40 / 36`
- backdrop blur: `5.5px`
- saturation: `142%`
- chromatic edge softening: `0.18`
- pointer response: up to about `3.2deg` tilt and `7px` lift
- clear tint: `13%` at rest, `21%` on hover, `28%` when selected in light mode

Local implementation files:

- `src/assets/liquid-glass-edge-map.png`
- `src/components/AmbientInteractionLayer.tsx`
- `src/styles/liquid-glass-26.css`
