import type { Service, ServiceStatus, LiveSystemMetrics } from './types';

/**
 * Deterministic, host-anchored telemetry for platform workloads.
 *
 * Services deployed on NexusHost share the underlying host. Their per-service
 * metrics are derived from the REAL host metrics (cpu %, ram %, network) using
 * a deterministic seeded PRNG keyed by service id + time bucket, so:
 *  - values are stable across reads for the same instant (no flicker),
 *  - they follow real host behaviour (run `stress-ng`/`yes` on the host and
 *    every service chart moves accordingly),
 *  - each service has its own personality (type, tier, uptime profile).
 */

export const BUILD_SECONDS = 6;
export const DEPLOY_SECONDS = 10;
export const PROVISION_SECONDS = 5;

export function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPE_PROFILE: Record<string, { cpu: number; ram: number; rpm: number; latency: number }> = {
  api: { cpu: 0.55, ram: 0.28, rpm: 420, latency: 38 },
  mcp: { cpu: 0.85, ram: 0.55, rpm: 980, latency: 26 },
  plugin: { cpu: 0.4, ram: 0.2, rpm: 260, latency: 55 },
};

export function computeServiceMetrics(
  service: {
    id: string;
    type: string;
    hardwareTier: string;
    instancesJson?: string;
    status: string;
    createdAt: Date;
    port?: number;
  },
  host: LiveSystemMetrics,
  ramTotalGbForTier: number
) {
  const seed = hashSeed(service.id);
  const now = Date.now();
  // 20-second buckets: stable within a bucket, evolves over time
  const bucket = Math.floor(now / 20_000);
  const rand = seededRandom(seed ^ bucket);
  const rand2 = seededRandom(seed ^ (bucket - 1));

  const profile = TYPE_PROFILE[service.type] ?? TYPE_PROFILE.api;
  const isGpuTier = service.hardwareTier.startsWith('gpu-') || service.hardwareTier === 'free-hf-space';

  // Host-anchored load: services share the machine, so their CPU tracks host CPU
  const hostFactor = host.cpu.usagePercent / 100;
  const drift = Math.sin(now / 45_000 + (seed % 1000)) * 0.5 + 0.5; // slow 0..1 wave
  const jitter = 0.12;

  const cpuPercent = clamp(
    4 + hostFactor * 100 * profile.cpu * (0.55 + drift * 0.5) + (rand() - 0.5) * 100 * jitter,
    1.2,
    96
  );

  const ramTotalGb = Math.max(0.25, ramTotalGbForTier);
  const ramUsedGb = clamp(
    ramTotalGb * (profile.ram + hostFactor * 0.25 + (rand() - 0.5) * 0.08),
    ramTotalGb * 0.08,
    ramTotalGb * 0.94
  );

  const requestsPerMin = Math.max(
    3,
    Math.round(profile.rpm * (0.35 + drift * 0.9 + hostFactor * 0.6) * (0.85 + rand() * 0.3))
  );

  const latencyP95Ms = +clamp(
    profile.latency * (0.6 + hostFactor * 1.8 + (rand() - 0.5) * 0.35) + (isGpuTier ? 6 : 0),
    5,
    900
  ).toFixed(1);

  const bandwidthInMb = +(requestsPerMin * 0.011 * (0.8 + rand() * 0.5)).toFixed(1);
  const bandwidthOutMb = +(requestsPerMin * 0.033 * (0.8 + rand() * 0.5)).toFixed(1);

  let metrics: Service['metrics'] = {
    cpuPercent: +cpuPercent.toFixed(1),
    ramUsedGb: +ramUsedGb.toFixed(2),
    ramTotalGb: +ramTotalGb.toFixed(2),
    requestsPerMin,
    latencyP95Ms,
    bandwidthInMb,
    bandwidthOutMb,
  };

  if (isGpuTier) {
    if (host.gpu.detected) {
      const vramTotalGb = (host.gpu.vramTotalMb ?? 16384) / 1024;
      metrics.gpuUtilPercent = clamp(host.gpu.utilPercent ?? 0 + rand() * 22, 0, 100);
      metrics.gpuVramUsedGb = +(((host.gpu.vramUsedMb ?? 0) / 1024) * (0.7 + rand() * 0.3)).toFixed(1);
      metrics.gpuVramTotalGb = +vramTotalGb.toFixed(1);
    }
    // When the host exposes no GPU we simply leave GPU fields undefined —
    // the UI shows "No GPU detected on host" instead of fake numbers.
  }

  if (service.type === 'mcp') {
    metrics.activeMcpClients = Math.max(0, Math.round(requestsPerMin / 38 + rand() * 6));
  }

  return metrics;
}

/** Derive a service metric time-series aligned with real host samples. */
export function deriveServiceSeries(
  service: { id: string; type: string; hardwareTier: string },
  hostSamples: { timestamp: Date; cpuPercent: number; ramUsedGb: number; ramTotalGb: number; extraJson?: string | null }[],
  ramTotalGbForTier: number
) {
  const seed = hashSeed(service.id);
  const profile = TYPE_PROFILE[service.type] ?? TYPE_PROFILE.api;
  return hostSamples.map((s) => {
    const t = new Date(s.timestamp).getTime();
    const bucket = Math.floor(t / 20_000);
    const rand = seededRandom(seed ^ bucket);
    const hostFactor = s.cpuPercent / 100;
    const drift = Math.sin(t / 45_000 + (seed % 1000)) * 0.5 + 0.5;
    const cpu = clamp(4 + hostFactor * 100 * profile.cpu * (0.55 + drift * 0.5) + (rand() - 0.5) * 12, 1.2, 96);
    const ramTotalGb = Math.max(0.25, ramTotalGbForTier);
    const ram = clamp(
      ramTotalGb * (profile.ram + hostFactor * 0.25 + (rand() - 0.5) * 0.08),
      ramTotalGb * 0.08,
      ramTotalGb * 0.94
    );
    const rpm = Math.max(3, Math.round(profile.rpm * (0.35 + drift * 0.9 + hostFactor * 0.6) * (0.85 + rand() * 0.3)));
    const latency = +clamp(profile.latency * (0.6 + hostFactor * 1.8 + (rand() - 0.5) * 0.35), 5, 900).toFixed(1);
    return {
      timestamp: s.timestamp,
      cpuPercent: +cpu.toFixed(1),
      ramUsedGb: +ram.toFixed(2),
      ramTotalGb: +ramTotalGb.toFixed(2),
      requestsPerMin: rpm,
      latencyP95Ms: latency,
    };
  });
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Deterministic derived metrics for provisioned databases (host-anchored). */
export function computeDbMetrics(kind: 'postgres' | 'redis', id: string, host: LiveSystemMetrics) {
  const seed = hashSeed(id);
  const bucket = Math.floor(Date.now() / 30_000);
  const rand = seededRandom(seed ^ bucket);
  const hostFactor = host.cpu.usagePercent / 100;

  if (kind === 'postgres') {
    return {
      cpuPercent: +clamp(2 + hostFactor * 34 * (0.6 + rand() * 0.8), 0.5, 92).toFixed(1),
      memoryMb: +clamp(180 + hostFactor * 640 + rand() * 120, 64, 4096).toFixed(0),
      activeConnections: Math.round(2 + rand() * 14 + hostFactor * 10),
    };
  }
  return {
    usedMemoryMb: +(6 + rand() * 12 + hostFactor * 6).toFixed(1),
    connectedClients: Math.round(1 + rand() * 9),
    hitRatePercent: +clamp(72 + rand() * 26, 40, 99.8).toFixed(1),
    opsPerSec: Math.round(120 + rand() * 900 + hostFactor * 800),
  };
}
