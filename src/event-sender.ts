/**
 * Event Sender for Cloudflare Workers
 *
 * Batches and sends RAW events to SeeLLM API.
 * API does all AI classification (single source of truth).
 * Uses Cloudflare's waitUntil for non-blocking async sends.
 */

export interface SiteEvent {
  // Request info
  path: string;
  method: string;
  timestamp: string;
  // Response info
  status: number;
  content_type?: string;
  content_length?: number;
  // Raw signals for API classification
  ua?: string;
  accept?: string;
  country?: string;
  referrer?: string;
  asn?: string;
  // Geographic data from Cloudflare
  city?: string;
  region?: string; // State/Province code (e.g., "CA", "NY")
  timezone?: string; // IANA timezone (e.g., "America/Los_Angeles")
  continent?: string; // Continent code (NA, EU, AS, etc.)
}

interface EventBatch {
  events: SiteEvent[];
  lastFlush: number;
}

// In-memory batch storage (per isolate)
let eventBatch: EventBatch = {
  events: [],
  lastFlush: Date.now(),
};

const BATCH_SIZE = 50;
const BATCH_TIMEOUT_MS = 5000; // 5 seconds
const RUNTIME = 'cloudflare_worker';
const ADAPTER_VERSION = '0.1.2';
const POLICY_REFRESH_MS = 5 * 60 * 1000;

let cachedPolicy: { data: SiteEventsPolicyResponse; fetchedAt: number } | null = null;
let cachedSecretHex: string | null = null;
let cachedCryptoKey: CryptoKey | null = null;

export interface EventSenderConfig {
  apiUrl: string;
  apiKey: string;
  siteDomain: string;
  adapterId?: string;
  adapterSecret?: string;
  orgId?: string;
  runtime?: string;
}

/**
 * Queue an event for sending
 */
export function queueEvent(
  event: SiteEvent,
  config: EventSenderConfig,
  ctx: ExecutionContext
): void {
  eventBatch.events.push(event);

  // Check if we should flush
  const shouldFlush =
    eventBatch.events.length >= BATCH_SIZE ||
    Date.now() - eventBatch.lastFlush >= BATCH_TIMEOUT_MS;

  if (shouldFlush) {
    const eventsToSend = eventBatch.events;
    eventBatch = {
      events: [],
      lastFlush: Date.now(),
    };

    // Use waitUntil to send async without blocking response
    ctx.waitUntil(sendEvents(eventsToSend, config));
  }
}

/**
 * Force flush all queued events
 */
export function flushEvents(
  config: EventSenderConfig,
  ctx: ExecutionContext
): void {
  if (eventBatch.events.length === 0) return;

  const eventsToSend = eventBatch.events;
  eventBatch = {
    events: [],
    lastFlush: Date.now(),
  };

  ctx.waitUntil(sendEvents(eventsToSend, config));
}

/**
 * Send events to SeeLLM API
 */
async function sendEvents(
  events: SiteEvent[],
  config: EventSenderConfig
): Promise<void> {
  if (events.length === 0) return;

  try {
    const useHmac = hasHmac(config);
    const body = JSON.stringify({ events });

    if (useHmac) {
      await ensurePolicyFresh(config);
      const response = await signedFetch(config, '/api/site-events/ingest', {
        method: 'POST',
        body,
        headers: {
          'X-Site-Domain': config.siteDomain,
        },
      });

      if (!response.ok) {
        console.error(`[SeeLLM] Failed: ${response.status} ${response.statusText}`);
      } else {
        await sendHeartbeat(config, {
          events_sent: events.length,
          failures: 0,
          last_success_ts: new Date().toISOString(),
        });
      }
    } else {
      const response = await fetch(`${config.apiUrl}/api/site-events/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
          'X-Site-Domain': config.siteDomain,
        },
        body,
      });

      if (!response.ok) {
        console.error(`[SeeLLM] Failed: ${response.status} ${response.statusText}`);
      }
    }
  } catch (error) {
    console.error('[SeeLLM] Error:', error);
  }
}

async function sendHeartbeat(
  config: EventSenderConfig,
  payload: { events_sent?: number; failures?: number; last_success_ts?: string }
) {
  if (!hasHmac(config)) return;

  const body = JSON.stringify({
    adapter_id: config.adapterId,
    runtime: config.runtime || RUNTIME,
    adapter_version: ADAPTER_VERSION,
    ...payload,
    policy_version: cachedPolicy?.data.policyVersion,
  });

  await signedFetch(config, '/api/site-events/heartbeat', {
    method: 'POST',
    body,
  });
}

async function ensurePolicyFresh(config: EventSenderConfig) {
  if (!hasHmac(config)) return;
  if (cachedPolicy && Date.now() - cachedPolicy.fetchedAt < POLICY_REFRESH_MS) {
    return;
  }

  const response = await signedFetch(config, '/api/site-events/policy', {
    method: 'GET',
  });

  if (!response.ok) {
    console.warn(`[SeeLLM] Failed to fetch policy: ${response.status}`);
    return;
  }

  const data = (await response.json()) as SiteEventsPolicyResponse;
  cachedPolicy = {
    data,
    fetchedAt: Date.now(),
  };
}

function hasHmac(config: EventSenderConfig): boolean {
  return Boolean(config.adapterId && config.adapterSecret && config.orgId);
}

export async function sendAdapterRequest(
  config: EventSenderConfig,
  path: string,
  init: {
    method?: string;
    body?: Record<string, unknown> | string | null;
    headers?: Record<string, string>;
  } = {}
) {
  const method = init.method || 'POST';
  const bodyString =
    typeof init.body === 'string'
      ? init.body
      : init.body
      ? JSON.stringify(init.body)
      : '';

  if (hasHmac(config)) {
    return signedFetch(config, path, {
      method,
      body: bodyString,
      headers: init.headers,
    });
  }

  if (!config.apiKey) {
    throw new Error('Adapter credentials or API key required');
  }

  const headers: Record<string, string> = {
    ...(bodyString ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers || {}),
    Authorization: `Bearer ${config.apiKey}`,
  };

  if (config.siteDomain && !headers['X-Site-Domain']) {
    headers['X-Site-Domain'] = config.siteDomain;
  }

  return fetch(`${config.apiUrl}${path}`, {
    method,
    headers,
    body: bodyString || undefined,
  });
}

async function signedFetch(
  config: EventSenderConfig,
  path: string,
  init: { method: string; body?: string; headers?: Record<string, string> }
) {
  if (!config.adapterSecret || !config.adapterId || !config.orgId) {
    throw new Error('Adapter credentials missing');
  }

  const timestamp = new Date().toISOString();
  const body = init.body || '';
  const signature = await signPayload(config.adapterSecret, timestamp, body);

  const headers: Record<string, string> = {
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...init.headers,
    'X-Seellm-Org-Id': config.orgId,
    'X-Seellm-Adapter-Id': config.adapterId,
    'X-Seellm-Timestamp': timestamp,
    'X-Seellm-Signature': signature,
  };

  if (config.siteDomain && !headers['X-Site-Domain']) {
    headers['X-Site-Domain'] = config.siteDomain;
  }

  return fetch(`${config.apiUrl}${path}`, {
    method: init.method,
    headers,
    body: body || undefined,
  });
}

async function signPayload(secretHex: string, timestamp: string, payload: string): Promise<string> {
  const message = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const key = await getCryptoKey(secretHex);
  const signature = await crypto.subtle.sign('HMAC', key, data);
  return bufferToHex(signature);
}

async function getCryptoKey(secretHex: string): Promise<CryptoKey> {
  if (cachedCryptoKey && cachedSecretHex === secretHex) {
    return cachedCryptoKey;
  }

  // API treats the secret as a UTF-8 string, not hex-decoded bytes
  const bytes = new TextEncoder().encode(secretHex);
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  cachedCryptoKey = key;
  cachedSecretHex = secretHex;
  return key;
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface SiteEventsPolicyResponse {
  policyVersion: string;
  aiRules: {
    allow: string[];
    block: string[];
  };
  sampling: {
    human: number;
  };
  logging: {
    level: string;
  };
}

/**
 * Create a site event from request/response (RAW data only)
 */
export function createSiteEvent(
  request: Request,
  response: Response,
  asn?: string
): SiteEvent {
  const url = new URL(request.url);
  const cf = (request as any).cf;

  return {
    path: url.pathname + url.search,
    method: request.method,
    timestamp: new Date().toISOString(),
    status: response.status,
    content_type: response.headers.get('content-type') || undefined,
    content_length: parseInt(response.headers.get('content-length') || '0', 10) || undefined,
    // Raw signals - API will classify
    ua: request.headers.get('user-agent') || undefined,
    accept: request.headers.get('accept') || undefined,
    country: cf?.country || undefined,
    referrer: request.headers.get('referer') || undefined,
    asn: asn,
    // Geographic data from Cloudflare
    city: cf?.city || undefined,
    region: cf?.regionCode || undefined,
    timezone: cf?.timezone || undefined,
    continent: cf?.continent || undefined,
  };
}
