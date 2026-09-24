import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { deriveServiceSeries } from '@/lib/hoster/telemetry';
import { tierSpec } from '@/lib/hoster/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const row = await db.service.findUnique({ where: { id } });
    if (!row) return NextResponse.json({ error: 'Service not found' }, { status: 404 });

    const url = new URL(req.url);
    const rawPoints = Number(url.searchParams.get('points') ?? '40');
    const points = Math.min(120, Math.max(1, Number.isFinite(rawPoints) ? Math.round(rawPoints) : 40));

    const hostSamples = await db.metricSample.findMany({
      where: { scope: 'host' },
      orderBy: { timestamp: 'desc' },
      take: points,
    });
    hostSamples.reverse(); // oldest → newest for charting

    const data = deriveServiceSeries(
      { id: row.id, type: row.type, hardwareTier: row.hardwareTier },
      hostSamples,
      tierSpec(row.hardwareTier).ramGb
    );

    return NextResponse.json({ data });
  } catch (err) {
    console.error('[api/services/[id]/history] GET failed', err);
    return NextResponse.json({ error: 'Failed to load service history' }, { status: 500 });
  }
}
