import { invoke } from '@tauri-apps/api/core';

export type NetworkEgressObservationState = 'measured' | 'partial' | 'unknown';
export type EgressSourceObservationState = 'controller_observed' | 'not_observed';

export interface ProxyCandidate {
  source: string;
  enabled: boolean;
  endpoint: string | null;
  pacUrl: string | null;
  bypass: string | null;
  listenerReachable: boolean | null;
  evidence: string;
}

export interface ProxyDetection {
  selectedSource: string | null;
  selectedEndpoint: string | null;
  selectedPacUrl: string | null;
  listenerReachable: boolean | null;
  candidates: ProxyCandidate[];
}

export interface ControllerDetection {
  status: 'connected' | 'unavailable' | 'not_detected';
  transport: string | null;
  endpoint: string | null;
  implementation: string | null;
  version: string | null;
  configPath: string | null;
  activeConnections: number;
  downloadTotal: number;
  uploadTotal: number;
  error: string | null;
}

export interface PublicEgressProbe {
  state: 'measured' | 'failed' | 'not_run';
  publicIp: string | null;
  countryCode: string | null;
  viaProxy: boolean;
  proxySource: string | null;
  scope: 'backend_process' | string;
  provider: string | null;
  error: string | null;
}

export interface NetworkEgressSourceSnapshot {
  id: string;
  observationState: EgressSourceObservationState;
  processNames: string[];
  routes: string[];
  nodes: string[];
  rules: string[];
  activeConnections: number;
  downloadBytes: number;
  uploadBytes: number;
  publicIp: string | null;
}

export interface NetworkEgressActiveConnection {
  id: string;
  source: string;
  process: string | null;
  processId: number | null;
  processSource: 'controller_metadata' | 'windows_tcp_owner' | 'unresolved' | string;
  sourcePort: number | null;
  target: string;
  protocol: string;
  route: string | null;
  node: string | null;
  chains: string[];
  rule: string | null;
  downloadBytes: number;
  uploadBytes: number;
  start: string | null;
  observationState: EgressSourceObservationState;
}

export interface NetworkEgressWarning {
  code: string;
  message: string;
}

export interface NetworkEgressSnapshot {
  capturedAt: string;
  platform: string;
  observationState: NetworkEgressObservationState;
  proxy: ProxyDetection;
  controller: ControllerDetection;
  publicProbe: PublicEgressProbe;
  sources: NetworkEgressSourceSnapshot[];
  activeConnections: NetworkEgressActiveConnection[];
  warnings: NetworkEgressWarning[];
}

/**
 * Reads an authoritative snapshot from the desktop backend. Deliberately has no
 * browser/demo fallback: an unavailable controller must remain unknown instead
 * of silently turning into convincing-looking sample data.
 */
export async function getNetworkEgressSnapshot(): Promise<NetworkEgressSnapshot> {
  return invoke<NetworkEgressSnapshot>('get_network_egress_snapshot');
}
