import { useEffect, useRef, useState } from 'react';
import { PERFORMANCE_MODE_ATTRIBUTE } from '../utils/performanceMode';

export function PetFishCursorLayer({ enabled = true }: { enabled?: boolean }) {
  const cursorRef = useRef<HTMLDivElement>(null);
  const bubbleLayerRef = useRef<HTMLDivElement>(null);
  const [liteMode, setLiteMode] = useState(
    () => document.documentElement.getAttribute(PERFORMANCE_MODE_ATTRIBUTE) === 'lite',
  );

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setLiteMode(document.documentElement.getAttribute(PERFORMANCE_MODE_ATTRIBUTE) === 'lite');
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [PERFORMANCE_MODE_ATTRIBUTE],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    let frame = 0;

    // Pointer target, and the fish's own eased position that chases it.
    let targetX = window.innerWidth / 2;
    let targetY = window.innerHeight / 2;
    let fishX = targetX;
    let fishY = targetY;
    let heading = 0; // radians, the way the fish is pointing
    let prevHeading = 0;
    let swimPhase = 0; // travelling-wave phase (accumulated so speed can vary)
    let bendState = 0; // eased body curvature from turning
    let lastMoveTime = performance.now();
    let last = performance.now();

    // Cache the redrawable body path + eye so we can rebuild the outline each frame.
    const el0 = cursorRef.current;
    const bodyEl = el0 ? el0.querySelector<SVGPathElement>('.pet-fish-body') : null;
    const eyeEl = el0 ? el0.querySelector<SVGGElement>('.pet-fish-eye') : null;

    // Keep the bow foam inside the fish's small local SVG. Updating a path in a
    // viewport-sized SVG forced WebView2 to repaint a full-screen surface for a
    // 10px splash; the local path produces the same nose crest at a tiny cost.
    const wBow = el0 ? el0.querySelector<SVGPathElement>('.pet-bow-foam') : null;

    let foamAlpha = 0; // eased 0..1 bow-foam visibility (only when cutting water)

    // Build the fish silhouette from a flexing spine that carries a wave from
    // head (right) to tail (left) — real fish undulation, not a rigid shear.
    // amp = lateral sway that grows toward the tail; curve = steady bend from turning.
    const SEG = 12;
    const buildFish = (phase: number, amp: number, curve: number) => {
      const cx = (s: number) => 66 - 52 * s; // nose x=66 -> tail base x=14
      const yoff = (s: number) =>
        20 +
        amp * (0.12 + 0.88 * Math.pow(s, 1.5)) * Math.sin(Math.PI * 2 * 1.1 * s - phase) +
        curve * s * s;
      const bodyW = (s: number) => 8.4 * Math.pow(Math.sin(Math.PI * (0.06 + 0.9 * s)), 0.75);
      const dorsal = (s: number) => 3.1 * Math.exp(-Math.pow((s - 0.42) / 0.13, 2));
      const anal = (s: number) => 1.9 * Math.exp(-Math.pow((s - 0.62) / 0.12, 2));

      const px: number[] = [];
      const py: number[] = [];
      for (let i = 0; i <= SEG; i++) {
        const s = i / SEG;
        px.push(cx(s));
        py.push(yoff(s));
      }
      const up: string[] = [];
      const lo: string[] = [];
      for (let i = 0; i <= SEG; i++) {
        const s = i / SEG;
        const a = Math.max(0, i - 1);
        const b = Math.min(SEG, i + 1);
        let tx = px[b] - px[a];
        let ty = py[b] - py[a];
        const l = Math.hypot(tx, ty) || 1;
        tx /= l;
        ty /= l;
        const nx = -ty;
        const ny = tx; // unit normal
        const wu = bodyW(s) + dorsal(s);
        const wl = bodyW(s) + anal(s);
        up.push(`L ${(px[i] + nx * wu).toFixed(2)} ${(py[i] + ny * wu).toFixed(2)}`);
        lo.push(`L ${(px[i] - nx * wl).toFixed(2)} ${(py[i] - ny * wl).toFixed(2)}`);
      }
      // forked caudal fin, swinging with the spine's tail end
      let dx = px[SEG] - px[SEG - 1];
      let dy = py[SEG] - py[SEG - 1];
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl;
      dy /= dl;
      const nx = -dy;
      const ny = dx;
      const tl = 13;
      const tipA = `L ${(px[SEG] + dx * tl + nx * 6.5).toFixed(2)} ${(py[SEG] + dy * tl + ny * 6.5).toFixed(2)}`;
      const notch = `L ${(px[SEG] + dx * tl * 0.55).toFixed(2)} ${(py[SEG] + dy * tl * 0.55).toFixed(2)}`;
      const tipB = `L ${(px[SEG] + dx * tl - nx * 6.5).toFixed(2)} ${(py[SEG] + dy * tl - ny * 6.5).toFixed(2)}`;
      const nose = `M ${(px[0] + 1.6).toFixed(2)} ${py[0].toFixed(2)}`;
      const d = `${nose} ${up.join(' ')} ${tipA} ${notch} ${tipB} ${lo.slice().reverse().join(' ')} Z`;

      // eye rides the head, a touch above the spine
      const se = 0.12;
      return { d, eyeX: cx(se), eyeY: yoff(se) - 4.4 };
    };

    // A loose body-follow reads as a lively little creature with inertia rather
    // than a rigid 1:1 pointer. Heading turns a bit faster so it banks into the
    // direction it's swimming. Both are frame-rate independent (per real second),
    // so it stays smooth at 60fps+ and never slows down on a dropped frame.
    const BODY_FOLLOW = 9;
    const TURN_SPEED = 11;
    // Lite keeps the fish, but reduces its redraw cadence instead of removing it.
    const FAST_FRAME_MS = 1000 / (liteMode ? 30 : 45);
    const SLOW_FRAME_MS = 1000 / (liteMode ? 15 : 24);
    const FAST_BODY_FRAME_MS = 1000 / (liteMode ? 14 : 24);
    const SLOW_BODY_FRAME_MS = 1000 / (liteMode ? 7 : 10);
    let lastBodyPaint = 0;

    const shortestAngle = (from: number, to: number) => {
      let d = to - from;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return d;
    };

    const step = (now: number) => {
      frame = 0;
      const sinceMove = now - lastMoveTime;
      const distanceToTarget = Math.hypot(targetX - fishX, targetY - fishY);
      const fastMotion = sinceMove < 260 || distanceToTarget > 10;
      const minimumFrameMs = fastMotion ? FAST_FRAME_MS : SLOW_FRAME_MS;
      if (now - last < minimumFrameMs) {
        frame = window.requestAnimationFrame(step);
        return;
      }

      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      const idle = sinceMove > 520;

      // When the pointer rests, the pet doesn't freeze — it eases into slowly
      // swimming little loops around the resting point, like a fish in a bowl.
      let goalX = targetX;
      let goalY = targetY;

      const t = 1 - Math.exp(-BODY_FOLLOW * dt);
      const dx = goalX - fishX;
      const dy = goalY - fishY;
      fishX += dx * t;
      fishY += dy * t;

      const stepDist = Math.hypot(dx, dy);
      if (stepDist > 0.05) {
        const targetHeading = Math.atan2(dy, dx);
        heading += shortestAngle(heading, targetHeading) * (1 - Math.exp(-TURN_SPEED * dt));
      }

      const el = cursorRef.current;
      if (el) {
        const deg = heading * (180 / Math.PI);
        // Keep the fish upright when it turns to face left (mirror instead of
        // going belly-up), same trick sprite fish use.
        const flip = Math.abs(deg) > 90 ? -1 : 1;
        const stretch = Math.min(0.26, stepDist / 22); // slight surge on darts
        const bob = idle ? Math.sin(now / 620) * 3 : 0; // gentle idle breathing
        el.style.transform =
          `translate3d(${fishX}px, ${fishY + bob}px, 0) rotate(${deg}deg) ` +
          `scale(${1 + stretch}, ${flip * (1 - stretch * 0.5)})`;

        // Undulating swim: a travelling wave runs head->tail down the spine so
        // the whole outline flexes like a real fish. Beats faster/harder the
        // quicker it swims and flutters while nuzzling, but never fully stops —
        // a gentle idle ripple keeps it alive.
        const beat = 6 + Math.min(18, stepDist * 1.7); // rad/s
        swimPhase += beat * dt;
        const amp = idle ? 2.4 : Math.min(7.5, 2.4 + stepDist * 0.62);

        // Bend the body into turns (eased so it doesn't jitter).
        const turnDeg = shortestAngle(prevHeading, heading) * (180 / Math.PI);
        prevHeading = heading;
        const targetBend = Math.max(-6, Math.min(6, turnDeg * 3));
        bendState += (targetBend - bendState) * (1 - Math.exp(-8 * dt));

        const bodyFrameMs = idle ? SLOW_BODY_FRAME_MS : FAST_BODY_FRAME_MS;
        const performanceTier = root.dataset.frameTier === 'performance';
        if (bodyEl && now - lastBodyPaint >= bodyFrameMs * (performanceTier ? 1.6 : 1)) {
          const fish = buildFish(swimPhase, amp, bendState);
          bodyEl.setAttribute('d', fish.d);
          if (eyeEl) {
            eyeEl.setAttribute('transform', `translate(${fish.eyeX.toFixed(2)} ${fish.eyeY.toFixed(2)})`);
          }
          lastBodyPaint = now;
        }
      }

      // --- Bow foam ---------------------------------------------------------
      // The long trail is intentionally gone; retain only the small splash at
      // the nose and let it recede immediately when pointer motion stops.
      const moving = sinceMove < 520 && stepDist > 0.5;
      if (wBow) {
        const foamTarget = moving ? Math.max(0, Math.min(1, (stepDist - 1) / 5)) : 0;
        foamAlpha += (foamTarget - foamAlpha) * (1 - Math.exp(-9 * dt));
        if (foamAlpha > 0.02) {
          wBow.style.opacity = (foamAlpha * 0.9).toFixed(3);
          wBow.style.setProperty('--pet-foam-scale', (0.42 + foamAlpha * 0.58).toFixed(3));
        } else {
          wBow.style.opacity = '0';
        }
      }

      const settled = sinceMove > 900
        && Math.hypot(targetX - fishX, targetY - fishY) < 0.18
        && foamAlpha < 0.015;
      if (!settled) frame = window.requestAnimationFrame(step);
    };

    const onPointerMove = (event: PointerEvent) => {
      targetX = event.clientX;
      targetY = event.clientY;
      lastMoveTime = performance.now();
      root.classList.add('has-pointer-motion');
      root.classList.add('has-pet'); // pet stays awake/visible from now on

      if (!frame) {
        last = lastMoveTime;
        frame = window.requestAnimationFrame(step);
      }

    };

    const onPointerLeave = () => {
      // Keep the pet visible and idling even when the pointer leaves the window.
      document.documentElement.classList.remove('has-pointer-motion');
    };

    const spawnClickBubbles = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.button !== 0) return;
      const layer = bubbleLayerRef.current;
      if (!layer) return;

      root.classList.add('has-pet');
      const directionX = Math.cos(heading);
      const directionY = Math.sin(heading);
      const normalX = -directionY;
      const normalY = directionX;
      const originX = fishX + directionX * 18;
      const originY = fishY + directionY * 18;
      const count = liteMode ? 3 : 4;
      const fragment = document.createDocumentFragment();

      // CSS owns the short animation, so a click does not start another JS
      // animation loop. The cap also prevents rapid clicking from accumulating
      // compositor layers.
      while (layer.childElementCount + count > 12) layer.firstElementChild?.remove();
      for (let index = 0; index < count; index += 1) {
        const bubble = document.createElement('i');
        bubble.className = 'pet-click-bubble';
        const spread = (index - (count - 1) / 2) * 5.2;
        const travel = 13 + index * 3.5;
        const rise = 11 + (index % 2) * 7;
        const size = 3.5 + (index % 3) * 1.35;
        bubble.style.left = `${originX + normalX * spread}px`;
        bubble.style.top = `${originY + normalY * spread}px`;
        bubble.style.width = `${size}px`;
        bubble.style.height = `${size}px`;
        bubble.style.setProperty('--bubble-dx', `${directionX * travel + normalX * spread * 0.34}px`);
        bubble.style.setProperty('--bubble-dy', `${directionY * travel + normalY * spread * 0.34 - rise}px`);
        bubble.style.setProperty('--bubble-delay', `${index * 24}ms`);
        bubble.style.setProperty('--bubble-duration', `${560 + index * 70}ms`);
        bubble.addEventListener('animationend', () => bubble.remove(), { once: true });
        fragment.appendChild(bubble);
      }
      layer.appendChild(fragment);
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        if (frame) window.cancelAnimationFrame(frame);
        frame = 0;
        return;
      }
      last = performance.now();
      if (!frame) frame = window.requestAnimationFrame(step);
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerdown', spawnClickBubbles, { passive: true, capture: true });
    document.documentElement.addEventListener('pointerleave', onPointerLeave);
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (!document.hidden) frame = window.requestAnimationFrame(step);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', spawnClickBubbles, true);
      document.documentElement.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      bubbleLayerRef.current?.replaceChildren();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [enabled, liteMode]);

  if (!enabled) return null;

  return (
      <div className="pet-cursor-layer" aria-hidden="true">
        <div className="pet-click-bubbles" ref={bubbleLayerRef} />
        <div className="pet-fish-cursor" ref={cursorRef}>
          <svg className="pet-fish-svg" viewBox="0 0 72 40" aria-hidden="true">
            <path className="pet-bow-foam" d="M 66 14.8 Q 74 20 66 25.2" />
            <path className="pet-fish-body" d="" />
            <g className="pet-fish-eye">
              <circle className="pet-eye-base" cx="0" cy="0" r="3" />
              <rect className="pet-eye-slit" x="-0.8" y="-2.6" width="1.6" height="5.2" rx="0.8" />
            </g>
          </svg>
        </div>
      </div>
  );
}
