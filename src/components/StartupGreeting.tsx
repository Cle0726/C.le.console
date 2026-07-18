import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readPerformanceMode } from '../utils/performanceMode';

interface GreetingPeriod {
  zh: string;
  en: string;
  code: string;
}

function resolveGreetingPeriod(hour: number): GreetingPeriod {
  if (hour < 5) return { zh: '夜深了', en: 'Still awake? Take it easy, Caiku.', code: 'LATE NIGHT / 02' };
  if (hour < 11) return { zh: '早上好', en: 'Good morning, Caiku.', code: 'MORNING / 08' };
  if (hour < 14) return { zh: '中午好', en: 'Good afternoon, Caiku.', code: 'NOON / 12' };
  if (hour < 18) return { zh: '下午好', en: 'Good afternoon, Caiku.', code: 'DAY / 15' };
  return { zh: '晚上好', en: 'Good evening, Caiku.', code: 'EVENING / 20' };
}

export function StartupGreeting({ onComplete }: { onComplete?: () => void }) {
  const liteMode = useMemo(() => readPerformanceMode() === 'lite', []);
  const [leaving, setLeaving] = useState(false);
  const [visible, setVisible] = useState(!liteMode);
  const completedRef = useRef(false);
  const now = useMemo(() => new Date(), []);
  const period = useMemo(() => resolveGreetingPeriod(now.getHours()), [now]);

  const complete = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    setVisible(false);
    onComplete?.();
  }, [onComplete]);

  useEffect(() => {
    if (liteMode) {
      complete();
      return;
    }
    const leaveTimer = window.setTimeout(() => setLeaving(true), 3420);
    const removeTimer = window.setTimeout(complete, 4180);
    return () => {
      window.clearTimeout(leaveTimer);
      window.clearTimeout(removeTimer);
    };
  }, [complete, liteMode]);

  const dismiss = () => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(complete, 700);
  };

  if (!visible || liteMode) return null;

  return (
    <div
      className={`startup-greeting${leaving ? ' is-leaving' : ''}`}
      role="status"
      aria-live="polite"
      onPointerDown={dismiss}
    >
      <div className="startup-greeting-grid" />
      <div className="startup-greeting-orbit" />
      <div className="startup-greeting-meta startup-greeting-meta-top">
        <span>C.LE / 启动序列 · BOOT SEQUENCE</span>
        <span>{period.code}</span>
      </div>

      <div className="startup-greeting-content">
        <div className="startup-greeting-eyebrow">
          <span />
          系统已就绪 · SYSTEM READY
        </div>
        <h1>
          {period.zh}
          <span className="startup-greeting-brand">，才酷。</span>
        </h1>
        <div className="startup-greeting-en">{period.en}</div>
        <div className="startup-greeting-rule"><i /></div>
        <p>哪怕只做一件小事，今天也会因此不同。</p>
        <p className="startup-greeting-quote-en">
          ONE SMALL MOVE CAN CHANGE THE DAY.
        </p>
      </div>

      <div className="startup-greeting-progress"><span /></div>
      <div className="startup-greeting-meta startup-greeting-meta-bottom">
        <span>{now.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</span>
        <span>点击任意处进入 · CLICK ANYWHERE TO CONTINUE</span>
        <strong>00—01</strong>
      </div>
    </div>
  );
}
