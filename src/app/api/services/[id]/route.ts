import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getHostMetrics } from '@/lib/hoster/metrics';
import { addLog, advanceServiceLifecycle, recomputeAllocations, serializeService } from '@/lib/hoster/server';
import { HARDWARE_SPECS } from '@/lib/hoster/hardware-specs';

export const dynamic = 'force-dynamic';

interface PatchBody {
  action?: unknown;
  description?: unknown;
  buildCommand?: unknown;
  startCommand?: unknown;
  envVars?: unknown;
  instances?: unknown;
  hardwareTier?: unknown;
  customDomains?: unknown;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

function normalizeEnvVars(raw: unknown): { key: string; value: string; isSecret: boolean }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (v): v is { key?: unknown; value?: unknown; isSecret?: unknown } =>
        !!v && typeof v === 'object' && typeof v.key === 'string' && v.key.trim() !== ''
    )
    .map((v) => ({ key: String(v.key).trim(), value: String(v.value ?? ''), isSecret: Boolean(v.isSecret) }));
}

function normalizeInstances(raw: unknown): {
  min: number;
  max: number;
  current: number;
  scaleToZero: boolean;
  scaleToZeroDelaySec: number;
} {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  if (!raw || typeof raw !== 'object') {
    return { min: 1, max: 1, current: 1, scaleToZero: false, scaleToZeroDelaySec: 300 };
  }
  const r = raw as Record<string, unknown>;
  return {
    min: Math.max(0, Math.round(num(r.min, 1))),
    max: Math.max(1, Math.round(num(r.max, 1))),
    current: Math.max(0, Math.round(num(r.current, 1))),
    scaleToZero: Boolean(r.scaleToZero),
    scaleToZeroDelaySec: Math.max(0, Math.round(num(r.scaleToZeroDelaySec, 300))),
  };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const row = await db.service.findUnique({ where: { id } });
    if (!row) return NextResponse.json({ error: 'Service not found' }, { status: 404 });

    const life = await advanceServiceLifecycle(row);
    const host = await getHostMetrics();
    return NextResponse.json({ data: serializeService(row, host, { statusOverride: life.status }) });
  } catch (err) {
    console.error('[api/services/[id]] GET failed', err);
    return NextResponse.json({ error: 'Failed to load service' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const row = await db.service.findUnique({ where: { id } });
    if (!row) return NextResponse.json({ error: 'Service not found' }, { status: 404 });

    let body: PatchBody;
    try {
      body = (await req.json()) as PatchBody;
    } catch {
      body = {};
    }

    const data: {
      status?: string;
      lifecycleStartedAt?: Date;
      description?: string;
      buildCommand?: string;
      startCommand?: string;
      envVarsJson?: string;
      instancesJson?: string;
      hardwareTier?: string;
      customDomainsJson?: string;
    } = {};

    const action = typeof body.action === 'string' ? body.action : undefined;
    if (action === 'stop') {
      data.status = 'stopped';
    } else if (action === 'start' || action === 'restart') {
      data.status = 'deploying';
      data.lifecycleStartedAt = new Date();
    } else if (action) {
      return NextResponse.json({ error: `Invalid action "${action}" (expected start, stop or restart)` }, { status: 400 });
    }

    if (body.description !== undefined) data.description = String(body.description);
    if (body.buildCommand !== undefined) data.buildCommand = String(body.buildCommand);
    if (body.startCommand !== undefined) data.startCommand = String(body.startCommand);
    if (body.envVars !== undefined) data.envVarsJson = JSON.stringify(normalizeEnvVars(body.envVars));
    if (body.instances !== undefined) data.instancesJson = JSON.stringify(normalizeInstances(body.instances));
    if (body.hardwareTier !== undefined) {
      const tier = String(body.hardwareTier);
      if (!(tier in HARDWARE_SPECS)) {
        return NextResponse.json({ error: `Unknown hardware tier "${tier}"` }, { status: 400 });
      }
      data.hardwareTier = tier;
    }
    if (body.customDomains !== undefined) {
      data.customDomainsJson = JSON.stringify(
        Array.isArray(body.customDomains) ? body.customDomains.map((d) => String(d).trim().toLowerCase()).filter(Boolean).slice(0, 20) : []
      );
    }

    const updated =
      Object.keys(data).length > 0 ? await db.service.update({ where: { id }, data }) : row;

    if (action === 'stop') {
      await addLog({
        serviceId: id,
        scope: 'service',
        message: `Service "${row.name}" stopped by operator. Compute released back to the provider pool.`,
      });
    } else if (action === 'start') {
      await addLog({
        serviceId: id,
        scope: 'service',
        message: `Cold start: re-deploying "${row.name}"...`,
      });
    } else if (action === 'restart') {
      await addLog({
        serviceId: id,
        scope: 'service',
        message: `Restarting "${row.name}" — draining connections first...`,
      });
    }
    if (body.envVars !== undefined) {
      await addLog({ serviceId: id, scope: 'service', message: `Environment variables updated for "${row.name}"` });
    }
    if (body.hardwareTier !== undefined && body.hardwareTier !== row.hardwareTier) {
      await addLog({
        serviceId: id,
        scope: 'service',
        message: `Hardware tier changed for "${row.name}": ${row.hardwareTier} → ${String(body.hardwareTier)}. Rescheduling workload...`,
        source: 'orchestrator',
      });
    }
    if (body.customDomains !== undefined) {
      await addLog({ serviceId: id, scope: 'service', message: `Custom domains updated for "${row.name}"` });
    }
    if (action) void recomputeAllocations().catch(() => {});

    const life = await advanceServiceLifecycle(updated);
    const host = await getHostMetrics();
    return NextResponse.json({ data: serializeService(updated, host, { statusOverride: life.status }) });
  } catch (err) {
    console.error('[api/services/[id]] PATCH failed', err);
    return NextResponse.json({ error: 'Failed to update service' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const row = await db.service.findUnique({ where: { id } });
    if (!row) return NextResponse.json({ error: 'Service not found' }, { status: 404 });

    await db.service.delete({ where: { id } }); // logs cascade via schema
    // Release resources tied to this service: custom domains go away, volumes are detached.
    await db.domain.deleteMany({ where: { serviceId: id } });
    await db.volume.updateMany({ where: { attachedToServiceId: id }, data: { attachedToServiceId: null } });

    await addLog({
      scope: 'service',
      message: `Service "${row.name}" deleted. Volumes detached, domains released.`,
    });
    void recomputeAllocations().catch(() => {});
    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    console.error('[api/services/[id]] DELETE failed', err);
    return NextResponse.json({ error: 'Failed to delete service' }, { status: 500 });
  }
}
