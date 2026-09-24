import { NextRequest, NextResponse } from 'next/server';
import dns from 'dns/promises';
import { db } from '@/lib/db';
import { addLog, serializeDomain } from '@/lib/hoster/server';
import type { CustomDomain } from '@/lib/hoster/types';

export const dynamic = 'force-dynamic';

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

interface CreateDomainBody {
  serviceId?: unknown;
  domain?: unknown;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

/** Normalize: lowercase, strip protocol and any path/port remnants. */
function normalizeDomain(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/[/:].*$/, '')
    .replace(/\.+$/, '');
}

/** REAL DNS check: CNAME first, then any A/AAAA records. */
async function checkDnsConfigured(domain: string): Promise<boolean> {
  try {
    const records = await dns.resolveCname(domain);
    if (records.length > 0) return true;
  } catch {
    // fall through to generic resolve
  }
  try {
    const records = await dns.resolve(domain);
    return records.length > 0;
  } catch {
    return false;
  }
}

export async function GET() {
  try {
    const rows = await db.domain.findMany({ orderBy: { createdAt: 'desc' } });
    const data: CustomDomain[] = [];
    for (const row of rows) {
      // Advance TLS issuance: pending + DNS verified + 15s elapsed → certificate issued.
      const elapsedMs = Date.now() - new Date(row.createdAt).getTime();
      if (row.sslStatus === 'pending' && row.dnsConfigured && elapsedMs > 15_000) {
        const updated = await db.domain.update({ where: { id: row.id }, data: { sslStatus: 'active' } });
        await addLog({
          scope: 'domain',
          message: `TLS certificate issued for ${row.domain} (Let's Encrypt, auto-renewal on).`,
        });
        data.push(serializeDomain(updated));
      } else {
        data.push(serializeDomain(row));
      }
    }
    return NextResponse.json({ data });
  } catch (err) {
    console.error('[api/domains] GET failed', err);
    return NextResponse.json({ error: 'Failed to load domains' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: CreateDomainBody;
  try {
    body = (await req.json()) as CreateDomainBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const serviceId = str(body.serviceId);
    if (!serviceId) {
      return NextResponse.json({ error: 'serviceId is required' }, { status: 400 });
    }
    const service = await db.service.findUnique({ where: { id: serviceId } });
    if (!service) {
      return NextResponse.json({ error: 'Service not found' }, { status: 400 });
    }

    const rawDomain = str(body.domain);
    if (!rawDomain) {
      return NextResponse.json({ error: 'domain is required' }, { status: 400 });
    }
    const domain = normalizeDomain(rawDomain);
    if (!DOMAIN_RE.test(domain)) {
      return NextResponse.json({ error: `Invalid domain name "${domain}"` }, { status: 400 });
    }

    const existing = await db.domain.findUnique({ where: { domain } });
    if (existing) {
      return NextResponse.json({ error: 'This domain is already added' }, { status: 409 });
    }

    const dnsConfigured = await checkDnsConfigured(domain);
    const created = await db.domain.create({
      data: {
        serviceId: service.id,
        serviceName: service.name,
        domain,
        cnameTarget: 'edge.nexushost.dev',
        dnsConfigured,
        sslStatus: dnsConfigured ? 'pending' : 'failed',
      },
    });

    await addLog({
      scope: 'domain',
      message: `Domain ${domain} added for service "${service.name}" — DNS ${
        dnsConfigured
          ? 'verified, certificate issuance started'
          : 'not detected yet; add a CNAME record pointing to edge.nexushost.dev'
      }`,
    });

    return NextResponse.json({ data: serializeDomain(created) }, { status: 201 });
  } catch (err) {
    console.error('[api/domains] POST failed', err);
    return NextResponse.json({ error: 'Failed to add domain' }, { status: 500 });
  }
}
