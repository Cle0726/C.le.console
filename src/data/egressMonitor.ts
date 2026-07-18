import type {
  EgressSourceObservationState,
  NetworkEgressSourceSnapshot,
} from '../services/networkEgressService';

export type EgressSourceId = 'local-api' | 'chatgpt' | 'claude' | 'other';
export type EgressHealth = 'matched' | 'mismatch' | 'unknown' | 'exempt';

export interface EgressSourceDefinition {
  id: EgressSourceId;
  label: string;
  english: string;
  short: string;
  expectedRoute: string;
  expectedRule: string;
  exemptFromMismatch: boolean;
}

export interface EgressVerdict {
  health: EgressHealth;
  isMismatch: boolean;
  isObserved: boolean;
  actualRoute: string;
  actualRule: string;
  mismatchedRoutes: string[];
}

export const EGRESS_SOURCE_DEFINITIONS: EgressSourceDefinition[] = [
  {
    id: 'local-api',
    label: '本地 API 服务',
    english: 'LOCAL API SERVICE',
    short: 'LOCAL API',
    expectedRoute: 'CodexFixed-US / 美国4原生',
    expectedRule: 'ProcessName(cle-cliproxy.exe)',
    exemptFromMismatch: false,
  },
  {
    id: 'chatgpt',
    label: '桌面 ChatGPT',
    english: 'CHATGPT DESKTOP',
    short: 'CHATGPT',
    expectedRoute: 'CodexFixed-US / 美国4原生',
    expectedRule: 'ProcessName(ChatGPT.exe)',
    exemptFromMismatch: false,
  },
  {
    id: 'claude',
    label: '桌面 Claude',
    english: 'CLAUDE DESKTOP',
    short: 'CLAUDE',
    expectedRoute: 'CodexFixed-US / 美国4原生',
    expectedRule: 'ProcessName(Claude.exe)',
    exemptFromMismatch: false,
  },
  {
    id: 'other',
    label: '其他',
    english: 'OTHER',
    short: 'OTHER',
    expectedRoute: '落云 / 日本1',
    expectedRule: 'MATCH',
    // “其他”聚合了未纳入前三类的连接。按产品规则它对应落云线路，
    // 只展示实测结果，不参与全局错误告警，避免聚合流量制造误报。
    exemptFromMismatch: true,
  },
];

export function isEgressSourceId(value: string): value is EgressSourceId {
  return value === 'local-api' || value === 'chatgpt' || value === 'claude' || value === 'other';
}

function normalizeSegment(value: string) {
  return value.trim().toLocaleLowerCase('en-US').replace(/\s+/g, '');
}

function routeSegments(route: string) {
  return route
    .split('/')
    .map(normalizeSegment)
    .filter(Boolean);
}

/**
 * Mihomo returns chains from leaf to selector while the UI writes the expected
 * route from selector to leaf. Compare segment membership instead of string
 * order, but still require every configured segment so an unrelated node with a
 * similar label cannot be treated as a match.
 */
export function routeMatchesExpectation(expectedRoute: string, actualRoute: string) {
  const expected = routeSegments(expectedRoute);
  const actual = new Set(routeSegments(actualRoute));
  return expected.length > 0 && expected.every((segment) => actual.has(segment));
}

function formatRules(rules: string[], routes: string[]) {
  const nonEmpty = rules.map((rule) => rule.trim()).filter(Boolean);
  if (nonEmpty.length > 0) return nonEmpty.join(' · ');
  if (routes.some((route) => routeSegments(route).includes('global'))) return 'GLOBAL';
  return '未报告 / NOT REPORTED';
}

function observationState(source?: NetworkEgressSourceSnapshot): EgressSourceObservationState {
  return source?.observationState ?? 'not_observed';
}

export function deriveEgressVerdict(
  definition: EgressSourceDefinition,
  source?: NetworkEgressSourceSnapshot,
): EgressVerdict {
  const routes = source?.routes.map((route) => route.trim()).filter(Boolean) ?? [];
  const actualRoute = routes.length > 0 ? routes.join(' · ') : '未观测 / NO SAMPLE';
  const actualRule = formatRules(source?.rules ?? [], routes);
  const isObserved = observationState(source) === 'controller_observed' && routes.length > 0;

  if (definition.exemptFromMismatch) {
    return {
      health: 'exempt',
      isMismatch: false,
      isObserved,
      actualRoute,
      actualRule,
      mismatchedRoutes: [],
    };
  }

  if (!isObserved) {
    return {
      health: 'unknown',
      isMismatch: false,
      isObserved: false,
      actualRoute,
      actualRule,
      mismatchedRoutes: [],
    };
  }

  const mismatchedRoutes = routes.filter(
    (route) => !routeMatchesExpectation(definition.expectedRoute, route),
  );
  const isMismatch = mismatchedRoutes.length > 0;
  return {
    health: isMismatch ? 'mismatch' : 'matched',
    isMismatch,
    isObserved: true,
    actualRoute,
    actualRule,
    mismatchedRoutes,
  };
}

export function getEgressSourceDefinition(id: string) {
  return EGRESS_SOURCE_DEFINITIONS.find((source) => source.id === id);
}
