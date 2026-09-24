import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { addLog, advanceVolumeLifecycle, serializeVolume } from '@/lib/hoster/server';
import type { PersistentVolume } from '@/lib/hoster/types';

export const dynamic = 'force-dynamic';

const VALID_TYPES: readonly string[] = ['nvme-ssd', 'gp3-ssd'];

interface CreateVolumeBody {
  name?: unknown;
  mountPath?: unknown;
  sizeGb?: unknown;
  type?: unknown;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

export async function GET() {
  try {
    const rows = await db.volume.findMany({ orderBy: { createdAt: 'desc' } });
    const data: PersistentVolume[] = [];
    for (const row of rows) {
      const usedGb = await advanceVolumeLifecycle(row);
      data.push(serializeVolume({ ...row, usedGb }));
    }
    return NextResponse.json({ data });
  } catch (err) {
    console.error('[api/volumes] GET failed', err);
    return NextResponse.json({ error: 'Failed to load volumes' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: CreateVolumeBody;
  try {
    body = (await req.json()) as CreateVolumeBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const name = str(body.name);
    if (!name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    const mountPath = str(body.mountPath);
    if (!mountPath.startsWith('/')) {
      return NextResponse.json({ error: 'mountPath must start with "/" (e.g. /data)' }, { status: 400 });
    }

    const sizeGb = typeof body.sizeGb === 'number' && Number.isFinite(body.sizeGb) ? body.sizeGb : NaN;
    if (!(sizeGb >= 1 && sizeGb <= 500)) {
      return NextResponse.json({ error: 'sizeGb must be a number between 1 and 500' }, { status: 400 });
    }

    const type = str(body.type) || 'nvme-ssd';
    if (!VALID_TYPES.includes(type)) {
      return NextResponse.json({ error: `Invalid type "${type}" (expected nvme-ssd or gp3-ssd)` }, { status: 400 });
    }

    const existing = await db.volume.findUnique({ where: { name } });
    if (existing) {
      return NextResponse.json({ error: 'A volume with this name already exists' }, { status: 409 });
    }

    const created = await db.volume.create({
      data: {
        name,
        mountPath,
        sizeGb,
        type,
        usedGb: 0,
        lifecycleStartedAt: new Date(),
      },
    });

    await addLog({
      scope: 'storage',
      message: `Provisioning ${sizeGb} GB ${type} volume "${name}" mounted at ${mountPath}...`,
    });

    return NextResponse.json({ data: serializeVolume(created) }, { status: 201 });
  } catch (err) {
    console.error('[api/volumes] POST failed', err);
    return NextResponse.json({ error: 'Failed to create volume' }, { status: 500 });
  }
}
