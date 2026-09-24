import { NextResponse } from 'next/server';
import { getHostMetrics } from '@/lib/hoster/metrics';
import { ensureHostSampler } from '@/lib/hoster/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/system/metrics — REAL host telemetry:
 * CPU (delta counters), RAM, disk (statfs), GPU (nvidia-smi/rocm-smi), network.
 * Also ensures the background sampler persists history samples every 15s.
 */
export async function GET() {
  try {
    ensureHostSampler();
    const metrics = await getHostMetrics();
    return NextResponse.json({ data: metrics });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || 'Failed to read host metrics' }, { status: 500 });
  }
}
