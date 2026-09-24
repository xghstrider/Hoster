import crypto from 'crypto';
import { db } from '@/lib/db';
import { getHostMetrics } from './metrics';
import { computeServiceMetrics, computeDbMetrics, BUILD_SECONDS, DEPLOY_SECONDS, PROVISION_SECONDS } from './telemetry';
import { HARDWARE_SPECS } from './hardware-specs';
import type {
  Service,
  PostgresDatabase,
  RedisDatabase,
  PersistentVolume,
  S3BucketConfig,
  CustomDomain,
  ConnectedProvider,
  CustomServerNode,
  LogEntry,
  LiveSystemMetrics,
} from './types';

type PrismaService = {
  id: string; name: string; description: string; type: string; status: string; repoUrl: string; branch: string;
  commitHash: string; commitMessage: string; url: string; hardwareTier: string; region: string;
  instancesJson: string; metricsJson: string; buildCommand: string; startCommand: string; port: number;
  protocol: string; envVarsJson: string; customDomainsJson: string; attachedPostgresId: string | null;
  attachedRedisId: string | null; volumeMountsJson: string; s3BucketId: string | null; mcpDetailsJson: string | null;
  pluginDetailsJson: string | null; lifecycleStartedAt: Date; createdAt: Date; updatedAt: Date;
};

// ─── Logging ─────────────────────────────────────────────────────────────────

export async function addLog(entry: {
  serviceId?: string | null;
  scope?: string;
  level?: string;
  message: string;
  source?: string;
}): Promise<void> {
  try {
    await db.logEntry.create({
      data: {
        serviceId: entry.serviceId ?? null,
        scope: entry.scope ?? 'system',
        level: entry.level ?? 'info',
        message: entry.message,
        source: entry.source ?? 'nexus-platform',
      },
    });
  } catch (err) {
    console.error('[hoster] failed to write log', err);
  }
}

// ─── Lifecycle state machine (advance-on-read) ──────────────────────────────

export type LifecycleResult = { status: string; progressNote: string | null };

export async function advanceServiceLifecycle(svc: PrismaService): Promise<LifecycleResult> {
  const elapsed = (Date.now() - new Date(svc.lifecycleStartedAt).getTime()) / 1000;
  let status = svc.status;
  let progressNote: string | null = null;

  if (svc.status === 'building' && elapsed >= BUILD_SECONDS) {
    status = 'deploying';
    await db.service.update({ where: { id: svc.id }, data: { status } });
    await addLog({
      serviceId: svc.id, scope: 'deploy', level: 'info',
      message: `Build finished (${svc.commitHash}). Pushing image to registry and provisioning ${svc.hardwareTier} in ${svc.region}.`,
      source: 'build-runner',
    });
    progressNote = 'build completed';
  }

  if (status === 'deploying' && elapsed >= BUILD_SECONDS + DEPLOY_SECONDS) {
    status = 'running';
    await db.service.update({ where: { id: svc.id }, data: { status } });
    await addLog({
      serviceId: svc.id, scope: 'deploy', level: 'info',
      message: `Service is live at ${svc.url} (health checks passing, TLS active).`,
      source: 'orchestrator',
    });
    progressNote = 'service live';
  }

  return { status, progressNote };
}

export async function advanceDatabaseLifecycle(
  row: { id: string; name: string; status: string; lifecycleStartedAt: Date },
  kind: 'postgres' | 'redis'
): Promise<string> {
  if (row.status !== 'provisioning') return row.status;
  const elapsed = (Date.now() - new Date(row.lifecycleStartedAt).getTime()) / 1000;
  if (elapsed >= PROVISION_SECONDS) {
    if (kind === 'postgres') {
      await db.postgresDb.update({ where: { id: row.id }, data: { status: 'available' } });
    } else {
      await db.redisDb.update({ where: { id: row.id }, data: { status: 'available' } });
    }
    await addLog({
      scope: 'database', level: 'info',
      message: `${kind === 'postgres' ? 'PostgreSQL' : 'Redis'} instance "${row.name}" finished provisioning and is accepting connections.`,
      source: 'db-provisioner',
    });
    return 'available';
  }
  return row.status;
}

export async function advanceVolumeLifecycle(row: { id: string; name: string; statusLike?: never; lifecycleStartedAt: Date; usedGb: number }): Promise<number> {
  const elapsed = (Date.now() - new Date(row.lifecycleStartedAt).getTime()) / 1000;
  if (row.usedGb === 0 && elapsed > 3) {
    // freshly formatted volume — baseline filesystem usage appears once formatted
    const baseline = +(Math.random() * 0.4 + 0.05).toFixed(2);
    await db.volume.update({ where: { id: row.id }, data: { usedGb: baseline } });
    return baseline;
  }
  return row.usedGb;
}

// ─── Hardware tier helpers ──────────────────────────────────────────────────

export function tierSpec(tier: string) {
  return HARDWARE_SPECS[tier] ?? HARDWARE_SPECS['cpu-nano'];
}

export const TIER_TO_PROVIDER: Record<string, string> = {
  'local-node': 'local-node',
  'free-hf-space': 'huggingface',
  'free-render': 'render',
  'free-fly': 'fly',
};

// ─── Serializers (DB rows → frontend types) ─────────────────────────────────

export function serializeService(
  row: PrismaService,
  host: LiveSystemMetrics,
  opts?: { statusOverride?: string; withMetrics?: boolean }
): Service {
  const status = (opts?.statusOverride ?? row.status) as Service['status'];
  const spec = tierSpec(row.hardwareTier);
  const instances = safeParse(row.instancesJson, { min: 1, max: 1, current: 1, scaleToZero: false, scaleToZeroDelaySec: 300 });
  const metrics =
    status === 'running'
      ? computeServiceMetrics({ ...row, instancesJson: row.instancesJson }, host, spec.ramGb)
      : safeParse(row.metricsJson, {
          cpuPercent: 0, ramUsedGb: 0, ramTotalGb: spec.ramGb, requestsPerMin: 0,
          latencyP95Ms: 0, bandwidthInMb: 0, bandwidthOutMb: 0,
        });

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type as Service['type'],
    status,
    repoUrl: row.repoUrl,
    branch: row.branch,
    commitHash: row.commitHash,
    commitMessage: row.commitMessage,
    deployedAt: formatRelative(row.createdAt),
    url: row.url,
    hardwareTier: row.hardwareTier as Service['hardwareTier'],
    region: row.region,
    instances,
    metrics,
    buildCommand: row.buildCommand,
    startCommand: row.startCommand,
    port: row.port,
    protocol: row.protocol as Service['protocol'],
    envVars: safeParse(row.envVarsJson, []),
    customDomains: safeParse(row.customDomainsJson, []),
    attachedPostgresId: row.attachedPostgresId ?? undefined,
    attachedRedisId: row.attachedRedisId ?? undefined,
    volumeMounts: safeParse(row.volumeMountsJson, []),
    s3BucketId: row.s3BucketId ?? undefined,
    mcpDetails: row.mcpDetailsJson ? safeParse(row.mcpDetailsJson, undefined) : undefined,
    pluginDetails: row.pluginDetailsJson ? safeParse(row.pluginDetailsJson, undefined) : undefined,
  };
}

export function serializePostgres(row: {
  id: string; name: string; version: string; region: string; status: string; storageGb: number; usedStorageGb: number;
  pgvectorEnabled: boolean; connectionString: string; pooledConnectionString: string; activeConnections: number;
  maxConnections: number; cpuPercent: number; memoryMb: number; lifecycleStartedAt: Date; createdAt: Date;
}, host: LiveSystemMetrics, statusOverride?: string): PostgresDatabase {
  const status = (statusOverride ?? row.status) as PostgresDatabase['status'];
  const live = status === 'available' ? computeDbMetrics('postgres', row.id, host) : null;
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    region: row.region,
    status,
    storageGb: row.storageGb,
    usedStorageGb: status === 'available' && live?.activeConnections !== undefined ? +(row.usedStorageGb + live.activeConnections * 0.002).toFixed(2) : row.usedStorageGb,
    pgvectorEnabled: row.pgvectorEnabled,
    connectionString: row.connectionString,
    pooledConnectionString: row.pooledConnectionString,
    activeConnections: live?.activeConnections ?? 0,
    maxConnections: row.maxConnections,
    cpuPercent: live?.cpuPercent ?? 0,
    memoryMb: live?.memoryMb ?? 0,
    createdAt: new Date(row.createdAt).toISOString(),
    attachedServiceIds: [],
  };
}

export function serializeRedis(row: {
  id: string; name: string; version: string; region: string; status: string; memoryLimitMb: number;
  evictionPolicy: string; connectionString: string; lifecycleStartedAt: Date; createdAt: Date;
}, host: LiveSystemMetrics, statusOverride?: string): RedisDatabase {
  const status = (statusOverride ?? row.status) as RedisDatabase['status'];
  const live = status === 'available' ? computeDbMetrics('redis', row.id, host) : null;
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    region: row.region,
    status,
    memoryLimitMb: row.memoryLimitMb,
    usedMemoryMb: live?.usedMemoryMb ?? 0,
    evictionPolicy: row.evictionPolicy as RedisDatabase['evictionPolicy'],
    connectionString: row.connectionString,
    connectedClients: live?.connectedClients ?? 0,
    hitRatePercent: live?.hitRatePercent ?? 0,
    opsPerSec: live?.opsPerSec ?? 0,
    createdAt: new Date(row.createdAt).toISOString(),
    attachedServiceIds: [],
  };
}

export function serializeVolume(row: { id: string; name: string; mountPath: string; sizeGb: number; usedGb: number; type: string; attachedToServiceId: string | null; createdAt: Date }): PersistentVolume {
  return {
    id: row.id,
    name: row.name,
    mountPath: row.mountPath,
    sizeGb: row.sizeGb,
    usedGb: row.usedGb,
    type: row.type as PersistentVolume['type'],
    attachedToServiceId: row.attachedToServiceId ?? undefined,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

export function serializeBucket(row: { id: string; name: string; provider: string; bucketName: string; region: string; endpointUrl: string | null; accessKeyId: string; isPublic: boolean; totalObjects: number; totalSizeMb: number; status: string; createdAt: Date }): S3BucketConfig {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider as S3BucketConfig['provider'],
    bucketName: row.bucketName,
    region: row.region,
    endpointUrl: row.endpointUrl ?? undefined,
    accessKeyId: row.accessKeyId,
    isPublic: row.isPublic,
    totalObjects: row.totalObjects,
    totalSizeMb: row.totalSizeMb,
    status: row.status as S3BucketConfig['status'],
  };
}

export function serializeDomain(row: { id: string; serviceId: string; serviceName: string; domain: string; cnameTarget: string; sslStatus: string; dnsConfigured: boolean; createdAt: Date }): CustomDomain {
  return {
    id: row.id,
    serviceId: row.serviceId,
    serviceName: row.serviceName,
    domain: row.domain,
    cnameTarget: row.cnameTarget,
    sslStatus: row.sslStatus as CustomDomain['sslStatus'],
    dnsConfigured: row.dnsConfigured,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

export function serializeLog(row: { id: string; createdAt: Date; level: string; message: string; source: string | null; serviceId?: string | null }): LogEntry {
  return {
    id: row.id,
    timestamp: new Date(row.createdAt).toISOString(),
    level: row.level as LogEntry['level'],
    message: row.message,
    source: row.source ?? undefined,
  };
}

// ─── Provider serializers ────────────────────────────────────────────────────

export function serializeProvider(row: {
  id: string; slug: string; name: string; type: string; category: string; status: string; token: string | null;
  endpointUrl: string | null; accountEmail: string | null; accountPlan: string | null; accountInfoJson: string | null;
  lastCheckedAt: Date | null; pingLatencyMs: number | null; capacityJson: string; allocatedJson: string;
  featuresJson: string; isBuiltIn: boolean; isFree: boolean; notes: string | null; tagsJson: string;
}): ConnectedProvider & { record: { token: string | null; endpointUrl: string | null; slug: string; isBuiltIn: boolean } } {
  return {
    id: row.id,
    name: row.name,
    type: row.type as ConnectedProvider['type'],
    category: row.category as ConnectedProvider['category'],
    status: row.status as ConnectedProvider['status'],
    apiKeyOrToken: row.token ? '••••••••' : undefined,
    endpointUrl: row.endpointUrl ?? undefined,
    accountEmail: row.accountEmail ?? undefined,
    accountPlan: row.accountPlan ?? undefined,
    lastChecked: row.lastCheckedAt ? new Date(row.lastCheckedAt).toISOString() : undefined,
    pingLatencyMs: row.pingLatencyMs ?? undefined,
    capacity: safeParse(row.capacityJson, { vCpu: 0, ramGb: 0, storageGb: 0 }),
    allocated: safeParse(row.allocatedJson, { vCpu: 0, ramGb: 0, servicesCount: 0 }),
    features: safeParse(row.featuresJson, []),
    isBuiltInFree: row.isBuiltIn && row.isFree,
    notes: row.notes ?? undefined,
    record: { token: row.token, endpointUrl: row.endpointUrl, slug: row.slug, isBuiltIn: row.isBuiltIn },
  };
}

export function serializeNode(row: {
  id: string; slug: string; name: string; type: string; category: string; status: string; endpointUrl: string | null;
  agentToken: string | null; lastHeartbeatAt: Date | null; pingLatencyMs: number | null; capacityJson: string;
  liveMetricsJson: string | null; tagsJson: string; osInfo: string | null; notes: string | null;
}): CustomServerNode {
  return {
    id: row.id,
    name: row.name,
    ipOrHost: row.endpointUrl ?? row.slug,
    connectionMethod: (row.type === 'custom_agent' ? 'agent' : row.type === 'custom_probe' ? 'probe_url' : 'manual') as CustomServerNode['connectionMethod'],
    status: row.status === 'connected' ? 'online' : row.status === 'error' ? 'warning' : 'offline',
    agentToken: row.agentToken ?? undefined,
    healthUrl: row.endpointUrl ?? undefined,
    lastHeartbeat: row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt).toISOString() : undefined,
    pingMs: row.pingLatencyMs ?? undefined,
    osInfo: row.osInfo ?? undefined,
    notes: row.notes ?? undefined,
    hardware: safeParse(row.capacityJson, { vCpu: 0, ramGb: 0, storageGb: 0 }),
    liveMetrics: row.liveMetricsJson ? safeParse(row.liveMetricsJson, undefined) : undefined,
    tags: safeParse(row.tagsJson, []),
  };
}

// ─── Capacity allocation rollup (real derived state) ─────────────────────────

export async function recomputeAllocations(): Promise<void> {
  const services = await db.service.findMany({ where: { status: { in: ['running', 'deploying', 'building'] } } });
  const providers = await db.provider.findMany();

  const alloc = new Map<string, { vCpu: number; ramGb: number; vramGb: number; servicesCount: number }>();
  const firstCustom = providers.find((p) => p.type === 'custom_agent' && p.status === 'connected');
  for (const p of providers) alloc.set(p.slug, { vCpu: 0, ramGb: 0, vramGb: 0, servicesCount: 0 });

  for (const svc of services) {
    const spec = tierSpec(svc.hardwareTier);
    const inst = safeParse(svc.instancesJson, { current: 1 });
    const count = Math.max(1, inst.current ?? 1);
    let slug = TIER_TO_PROVIDER[svc.hardwareTier];
    if (!slug) {
      slug = svc.hardwareTier === 'custom-vps' && firstCustom ? firstCustom.slug : 'local-node';
    }
    const cur = alloc.get(slug) ?? { vCpu: 0, ramGb: 0, vramGb: 0, servicesCount: 0 };
    cur.vCpu += (spec.vCpu ?? 0) * count;
    cur.ramGb += (spec.ramGb ?? 0) * count;
    cur.vramGb += (spec.vramGb ?? 0) * count;
    cur.servicesCount += 1;
    alloc.set(slug, cur);
  }

  for (const p of providers) {
    const a = alloc.get(p.slug) ?? { vCpu: 0, ramGb: 0, vramGb: 0, servicesCount: 0 };
    const json = JSON.stringify(a);
    if (p.allocatedJson !== json) {
      await db.provider.update({ where: { id: p.id }, data: { allocatedJson: json } });
    }
  }
}

// ─── Host metric sampler (persists real samples for history charts) ─────────

const SAMPLE_INTERVAL_MS = 15_000;
const MAX_SAMPLES = 2_400; // ~10 hours of history

export async function recordHostSample(): Promise<void> {
  const m = await getHostMetrics();
  await db.metricSample.create({
    data: {
      scope: 'host',
      scopeId: 'host',
      cpuPercent: m.cpu.usagePercent,
      ramUsedGb: m.memory.usedGb,
      ramTotalGb: m.memory.totalGb,
      diskUsedGb: m.storage.usedGb,
      diskTotalGb: m.storage.totalGb,
      netInMb: m.network?.rxKbPerSec ?? 0,
      netOutMb: m.network?.txKbPerSec ?? 0,
      extraJson: JSON.stringify({
        load: m.cpu.loadAvg,
        gpu: m.gpu.detected ? { util: m.gpu.utilPercent, vramUsed: m.gpu.vramUsedMb, temp: m.gpu.tempC } : null,
      }),
    },
  });
  // opportunistic trim
  const count = await db.metricSample.count({ where: { scope: 'host' } });
  if (count > MAX_SAMPLES) {
    const oldest = await db.metricSample.findFirst({ where: { scope: 'host' }, orderBy: { timestamp: 'asc' }, skip: count - MAX_SAMPLES });
    if (oldest) {
      await db.metricSample.deleteMany({ where: { scope: 'host', timestamp: { lte: oldest.timestamp } } });
    }
  }
}

type SamplerGlobal = typeof globalThis & { __hosterSampler?: { timer: NodeJS.Timeout; busy: boolean } };
const g = globalThis as SamplerGlobal;

/** Starts (once per process) a background sampler that records REAL host metrics every 15s. */
export function ensureHostSampler(): void {
  if (g.__hosterSampler) return;
  const sampler: { timer: NodeJS.Timeout; busy: boolean } = { timer: null as unknown as NodeJS.Timeout, busy: false };
  const tick = async () => {
    if (sampler.busy) return;
    sampler.busy = true;
    try {
      await recordHostSample();
    } catch (err) {
      console.error('[hoster] sample failed', err);
    } finally {
      sampler.busy = false;
    }
  };
  sampler.timer = setInterval(tick, SAMPLE_INTERVAL_MS);
  sampler.timer.unref?.();
  void tick(); // immediate first real sample
  g.__hosterSampler = sampler;
}

// ─── misc ────────────────────────────────────────────────────────────────────

export function safeParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function formatRelative(date: Date | string): string {
  const d = new Date(date).getTime();
  const diff = Math.max(0, Date.now() - d);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

export function genPassword(len = 18): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  const arr = new Uint32Array(len);
  crypto.webcrypto.getRandomValues(arr);
  for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length];
  return out;
}
