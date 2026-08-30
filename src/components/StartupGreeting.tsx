import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { readPerformanceMode } from '../utils/performanceMode';
import appIcon from '../assets/app-icon-rounded.png';
import { resolveGreetingCopy } from '../data/startupGreetings';
import { formatBeijingDate } from '../utils/beijingTime';
import './StartupGreeting.css';

type StartupPhase = 'loading' | 'ready' | 'leaving';

function waitForPageResources(timeoutMs: number): Promise<void> {
  const timeout = new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs));

  const ready = new Promise<void>((resolve) => {
    const collect = async () => {
      await new Promise<void>((next) => requestAnimationFrame(() => requestAnimationFrame(() => next())));

      const pending: Promise<unknown>[] = [];
      if (document.fonts?.ready) pending.push(document.fonts.ready);

      document.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
        if (image.complete) return;
        pending.push(
          new Promise<void>((next) => {
            image.addEventListener('load', () => next(), { once: true });
            image.addEventListener('error', () => next(), { once: true });
          }),
        );
      });

      await Promise.allSettled(pending);
      if ('requestIdleCallback' in window) {
        await new Promise<void>((next) =>
          window.requestIdleCallback(() => next(), { timeout: 500 }),
        );
      }
      resolve();
    };

    if (document.readyState === 'complete') {
      void collect();
    } else {
      window.addEventListener('load', () => void collect(), { once: true });
    }
  });

  return Promise.race([ready, timeout]);
}

export function StartupGreeting({
  onComplete,
  readyGate = true,
}: {
  onComplete?: () => void;
  readyGate?: boolean;
}) {
  const liteMode = useMemo(() => readPerformanceMode() === 'lite', []);
  const reducedMotion = useMemo(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    [],
  );
  const [phase, setPhase] = useState<StartupPhase>('loading');
  const [visible, setVisible] = useState(true);
  const [progress, setProgress] = useState(0);
  const completedRef = useRef(false);
  const readyGateRef = useRef(readyGate);
  const tryReadyRef = useRef<() => void>(() => undefined);
  const queuedContinueRef = useRef(false);
  const timerRefs = useRef<number[]>([]);
  const now = useMemo(() => new Date(), []);
  /* Drawn once per launch, so the line holds still while the screen is up. */
  const copy = useMemo(() => resolveGreetingCopy(now), [now]);
  readyGateRef.current = readyGate;

  const clearTimers = useCallback(() => {
    timerRefs.current.forEach((timer) => window.clearTimeout(timer));
    timerRefs.current = [];
  }, []);

  const complete = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    clearTimers();
    setVisible(false);
    onComplete?.();
  }, [clearTimers, onComplete]);

  const beginLeaving = useCallback(() => {
    setPhase((current) => (current === 'loading' ? current : 'leaving'));
  }, []);

  useEffect(() => {
    const startedAt = performance.now();
    /*
     * Shortened from 5.2s. An opening sequence earns its keep in the first
     * couple of seconds; past that it is a door held shut in front of an app
     * that is already loaded. The sentence now resolves as one motion and the
     * application is loaded behind it, so the screen only needs a brief hold.
     */
    const minimumVisibleMs = reducedMotion ? 800 : liteMode ? 1_250 : 1_600;
    const resourceTimeoutMs = reducedMotion ? 2_200 : 8_000;
    let cancelled = false;
    let resourcesReady = false;
    let minimumReady = false;

    const tryReady = () => {
      if (cancelled || !resourcesReady || !minimumReady || !readyGateRef.current) return;
      setProgress(100);
      setPhase('ready');
      const holdMs = queuedContinueRef.current ? 220 : reducedMotion ? 220 : 520;
      timerRefs.current.push(window.setTimeout(() => setPhase('leaving'), holdMs));
    };
    tryReadyRef.current = tryReady;

    void waitForPageResources(resourceTimeoutMs).then(() => {
      resourcesReady = true;
      tryReady();
    });

    timerRefs.current.push(
      window.setTimeout(() => {
        minimumReady = true;
        tryReady();
      }, minimumVisibleMs),
    );

    const progressTimer = window.setInterval(() => {
      const elapsed = performance.now() - startedAt;
      const ratio = Math.min(elapsed / minimumVisibleMs, 1);
      const eased = 1 - Math.pow(1 - ratio, 2.2);
      setProgress(Math.min(96, Math.round(eased * 96)));
    }, 90);

    return () => {
      cancelled = true;
      tryReadyRef.current = () => undefined;
      window.clearInterval(progressTimer);
      clearTimers();
    };
  }, [clearTimers, liteMode, reducedMotion]);

  useEffect(() => {
    if (readyGate) tryReadyRef.current();
  }, [readyGate]);

  useEffect(() => {
    if (phase !== 'leaving') return;
    const exitMs = reducedMotion ? 160 : liteMode ? 380 : 480;
    const timer = window.setTimeout(complete, exitMs);
    timerRefs.current.push(timer);
    return () => window.clearTimeout(timer);
  }, [complete, liteMode, phase, reducedMotion]);

  const handleContinue = () => {
    if (phase === 'ready') {
      beginLeaving();
      return;
    }
    if (phase === 'loading') queuedContinueRef.current = true;
  };

  if (!visible) return null;

  const title = copy.zh;
  const startupStyle = {
    '--sg-progress': progress / 100,
  } as CSSProperties;

  return (
    <div
      className={`startup-greeting sg is-${phase}`}
      data-performance={liteMode ? 'lite' : 'full'}
      data-startup-phase={phase}
      role="status"
      aria-live="polite"
      aria-busy={phase === 'loading'}
      style={startupStyle}
      onPointerDown={handleContinue}
    >
      <div className="sg-veil" aria-hidden="true" />

      <div className="sg-stack">
        <div className="sg-mark" aria-hidden="true">
          <img src={appIcon} alt="" draggable={false} />
        </div>

        <h1 className="sg-title" aria-label={title}>
          <span className="sg-title-line" aria-hidden="true">{title}</span>
        </h1>

        <p className="sg-en">{copy.en}</p>

        <div className="sg-rule" aria-hidden="true">
          <i />
        </div>

        <p className="sg-note">{copy.note}</p>
      </div>

      <div className="sg-foot">
        <span className="sg-foot-date">
          {formatBeijingDate(now, 'zh-CN', { month: '2-digit', day: '2-digit' })}
        </span>
        <span className="sg-foot-state">
          {phase === 'ready' ? '就绪' : '正在准备工作区'}
        </span>
      </div>
    </div>
  );
}
