import { useCallback, useEffect, useRef, useState } from 'react';
import { PERFORMANCE_MODE_ATTRIBUTE } from '../utils/performanceMode';

type ModelRotationOptions<T extends string> = {
  items: readonly T[];
  initialItem?: T;
  intervalMs?: number;
  manualResumeMs?: number;
  paused?: boolean;
};

function randomIndex(length: number): number {
  if (length <= 1) return 0;
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const value = new Uint32Array(1);
    crypto.getRandomValues(value);
    return value[0] % length;
  }
  return Math.floor(Math.random() * length);
}

function shuffledWithout<T>(items: readonly T[], excluded?: T): T[] {
  const pool = items.filter((item) => item !== excluded);
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const target = randomIndex(index + 1);
    [pool[index], pool[target]] = [pool[target], pool[index]];
  }
  return pool;
}

/**
 * Runs a non-repeating shuffle bag. Every model is shown once before the bag
 * is refilled, and environment-sensitive pauses prevent hidden/Lite/reduced
 * motion windows from spending work on automatic scene changes.
 */
export function useModelRotation<T extends string>({
  items,
  initialItem,
  intervalMs = 9600,
  manualResumeMs = 12000,
  paused = false,
}: ModelRotationOptions<T>) {
  const [activeItem, setActiveItem] = useState<T>(() => {
    if (initialItem && items.includes(initialItem)) return initialItem;
    return items[randomIndex(items.length)] ?? items[0];
  });
  const [scheduleVersion, setScheduleVersion] = useState(0);
  const [nextDelay, setNextDelay] = useState(intervalMs);
  const [environmentPaused, setEnvironmentPaused] = useState(false);
  const bagRef = useRef<T[]>(shuffledWithout(items, activeItem));
  const activeRef = useRef(activeItem);

  activeRef.current = activeItem;

  const takeNext = useCallback((manual = false) => {
    let bag = bagRef.current.filter((item) => item !== activeRef.current);
    if (bag.length === 0) bag = shuffledWithout(items, activeRef.current);
    const next = bag.shift() ?? items.find((item) => item !== activeRef.current) ?? activeRef.current;
    bagRef.current = bag;
    activeRef.current = next;
    setActiveItem(next);
    setNextDelay(manual ? manualResumeMs : intervalMs);
    setScheduleVersion((version) => version + 1);
  }, [intervalMs, items, manualResumeMs]);

  const selectItem = useCallback((item: T) => {
    if (!items.includes(item)) return;
    activeRef.current = item;
    bagRef.current = shuffledWithout(items, item);
    setActiveItem(item);
    setNextDelay(manualResumeMs);
    setScheduleVersion((version) => version + 1);
  }, [items, manualResumeMs]);

  const shuffleNow = useCallback(() => takeNext(true), [takeNext]);

  useEffect(() => {
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncEnvironment = () => {
      const liteMode = document.documentElement.getAttribute(PERFORMANCE_MODE_ATTRIBUTE) === 'lite';
      setEnvironmentPaused(document.hidden || motionQuery.matches || liteMode);
    };
    const observer = new MutationObserver(syncEnvironment);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [PERFORMANCE_MODE_ATTRIBUTE],
    });
    document.addEventListener('visibilitychange', syncEnvironment);
    motionQuery.addEventListener('change', syncEnvironment);
    syncEnvironment();
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', syncEnvironment);
      motionQuery.removeEventListener('change', syncEnvironment);
    };
  }, []);

  useEffect(() => {
    if (paused || environmentPaused || items.length < 2) return;
    const timer = window.setTimeout(() => takeNext(false), nextDelay);
    return () => window.clearTimeout(timer);
  }, [environmentPaused, items.length, nextDelay, paused, scheduleVersion, takeNext]);

  return {
    activeItem,
    activeIndex: Math.max(0, items.indexOf(activeItem)),
    selectItem,
    shuffleNow,
    environmentPaused,
  };
}
