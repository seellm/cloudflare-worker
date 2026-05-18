/**
 * SeeLLM AI Traffic Monitor - Cloudflare Worker
 *
 * Monitors all traffic to your site and detects AI crawlers.
 *
 * Setup:
 * 1. Edit wrangler.toml - set YOUR_DOMAIN and YOUR_API_KEY
 * 2. Run: npx wrangler deploy
 * 3. View stats at https://seellm.link
 */

import type { EventSenderConfig } from './event-sender';
import { queueEvent, flushEvents, createSiteEvent, sendAdapterRequest, sendHeartbeat } from './event-sender';
import { applyVisibilityPatches } from './patches';

const WORKER_VERSION = '0.1.10';
const PATCH_CAPABILITIES = [
  'answer_first_block',
  'freshness_update',
  'next_payload_freshness_rewrite',
  'citation_fragment',
];

export interface Env {
  SEELLM_API_KEY?: string;
  SEELLM_ADAPTER_ID?: string;
  SEELLM_ADAPTER_SECRET?: string;
  SEELLM_ORG_ID?: string;
  SEELLM_API_URL?: string;
  SEELLM_SITE_DOMAIN?: string;
  ORIGIN_URL?: string; // Origin server URL for local dev (e.g., http://localhost:3000)
  // Set to '1' or 'true' to disable automatic citation-fragment.js injection
  // into HTML responses. Default is enabled when adapter credentials are present.
  SEELLM_DISABLE_CITATION_INJECT?: string;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const siteDomain = env.SEELLM_SITE_DOMAIN || new URL(request.url).hostname;
    const config: EventSenderConfig = {
      apiUrl: env.SEELLM_API_URL || 'https://api.seellm.link',
      apiKey: env.SEELLM_API_KEY || '',
      siteDomain,
      adapterId: env.SEELLM_ADAPTER_ID,
      adapterSecret: env.SEELLM_ADAPTER_SECRET,
      orgId: env.SEELLM_ORG_ID,
      runtime: 'cloudflare_worker',
    };

    const url = new URL(request.url);

    // Health check endpoint — returns JSON so we can verify the Worker is running
    if (url.pathname === '/__seellm/health') {
      ctx.waitUntil(
        sendHeartbeat(config, {
          events_sent: 0,
          failures: 0,
          last_success_ts: new Date().toISOString(),
        }).catch((error) => {
          console.error('[SeeLLM] Health heartbeat failed', error);
        })
      );
      return new Response(JSON.stringify({
        ok: true,
        worker: 'seellm-site-monitor',
        worker_version: WORKER_VERSION,
        patch_capabilities: PATCH_CAPABILITIES,
        adapter_id: config.adapterId || null,
        has_credentials: Boolean(config.adapterId && config.adapterSecret),
        timestamp: new Date().toISOString(),
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    if (url.pathname === '/__seellm/citation-fragment') {
      return handleCitationFragment(request, config);
    }

    const hasAdapterCreds = Boolean(config.adapterId && config.adapterSecret && config.orgId);
    if (!hasAdapterCreds && !config.apiKey) {
      console.warn('SeeLLM adapter credentials not configured, skipping monitoring');
      return fetch(request);
    }

    // Get ASN from Cloudflare
    const cf = (request as any).cf;
    const asn = cf?.asn?.toString() || '';

    // Fetch from origin (don't block on monitoring)
    let originRequest = request;
    if (env.ORIGIN_URL) {
      // Rewrite request URL to point to configured origin
      const url = new URL(request.url);
      const originUrl = new URL(env.ORIGIN_URL);
      url.protocol = originUrl.protocol;
      url.host = originUrl.host;
      url.port = originUrl.port;
      originRequest = new Request(url.toString(), request);
    }
    const response = await fetch(originRequest);

    // Create and queue event with RAW data (API does classification)
    const event = createSiteEvent(request, response, asn);
    queueEvent(event, config, ctx);

    // Flush remaining events when worker is about to terminate
    ctx.waitUntil(
      (async () => {
        // Small delay to batch more events
        await new Promise(resolve => setTimeout(resolve, 100));
        flushEvents(config, ctx);
      })()
    );

    const patched = await applyVisibilityPatches(request, response, config);
    const citationInjectDisabled = isFlagEnabled(env.SEELLM_DISABLE_CITATION_INJECT);
    return citationInjectDisabled
      ? patched
      : injectCitationFragmentScript(patched, config);
  },
};

function isFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Auto-inject the citation-fragment.js beacon into every HTML response
 * served to a configured SeeLLM customer. The snippet detects text-fragment
 * URLs (Chrome's `#:~:text=…`) that AI assistants generate when citing a
 * page and beacons the rendered paragraph back via `/__seellm/citation-fragment`.
 *
 * Removes the Step-8 setup burden: any customer with adapter credentials
 * gets citation capture for free, no script tag to paste.
 *
 * Uses Cloudflare's streaming HTMLRewriter so we don't buffer the body.
 * The snippet itself is sessionStorage-deduped, so double-loading
 * (manual install + auto-inject) is harmless.
 */
function injectCitationFragmentScript(
  response: Response,
  config: EventSenderConfig,
): Response {
  if (!config.adapterId || !config.adapterSecret) return response;
  if (response.status < 200 || response.status >= 300) return response;
  const contentType = response.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().includes('text/html')) return response;
  // HTMLRewriter is a Cloudflare-runtime global — undefined in Node/vitest
  // test environments where the worker is unit-tested without miniflare.
  // Skip the inject in that case; production Workers always have it.
  if (typeof (globalThis as any).HTMLRewriter === 'undefined') return response;

  const snippetUrl = `${config.apiUrl}/snippets/citation-fragment.js`;
  return new HTMLRewriter()
    .on('head', {
      element(el) {
        el.append(
          `<script async src="${snippetUrl}" data-seellm-citation-auto="1"></script>`,
          { html: true },
        );
      },
    })
    .transform(response);
}

export function clamp(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

async function handleCitationFragment(
  request: Request,
  config: EventSenderConfig
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let payload: any;
  try {
    payload = await request.json();
  } catch (err) {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (!payload || typeof payload !== 'object') {
    return new Response('Invalid payload', { status: 400 });
  }

  const sanitized: Record<string, unknown> = {
    fragment: clamp(payload.fragment, 500),
    selector: clamp(payload.selector, 1000),
    hash: clamp(payload.hash, 2000),
    url: clamp(payload.url, 2000),
    referrer: clamp(payload.referrer, 2000),
    source: clamp(payload.source, 100),
    language: clamp(payload.language, 20),
    capturedAt: new Date().toISOString(),
  };

  if (!sanitized.fragment || !sanitized.url) {
    return new Response('Missing fragment or url', { status: 400 });
  }

  const viewport = payload.viewport || {};
  if (viewport && typeof viewport.width === 'number' && typeof viewport.height === 'number') {
    sanitized.viewport = {
      width: viewport.width,
      height: viewport.height,
    };
  }

  sanitized.userAgent = clamp(payload.userAgent, 2000) || request.headers.get('user-agent') || undefined;

  try {
    const upstream = await sendAdapterRequest(config, '/api/citation-fragments', {
      method: 'POST',
      body: sanitized,
      headers: {
        'Content-Type': 'application/json',
      },
    });
    if (!upstream.ok) {
      console.error('[SeeLLM] Citation fragment API error', upstream.status);
      return new Response('Upstream error', { status: 502 });
    }
    return new Response(null, { status: 202 });
  } catch (error) {
    console.error('[SeeLLM] Failed to forward citation fragment', error);
    return new Response('Upstream error', { status: 502 });
  }
}
