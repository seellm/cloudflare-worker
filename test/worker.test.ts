import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clamp } from '../src/index';
import type { Env } from '../src/index';
import { clearPatchCache } from '../src/patches';

// Import the default export (the worker fetch handler)
import worker from '../src/index';

/**
 * Helper to create a mock ExecutionContext
 */
function createMockCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

describe('clamp', () => {
  it('returns undefined for non-string values', () => {
    expect(clamp(undefined, 100)).toBeUndefined();
    expect(clamp(null, 100)).toBeUndefined();
    expect(clamp(42, 100)).toBeUndefined();
    expect(clamp(true, 100)).toBeUndefined();
    expect(clamp({}, 100)).toBeUndefined();
  });

  it('returns string unchanged if under max length', () => {
    expect(clamp('hello', 10)).toBe('hello');
    expect(clamp('', 10)).toBe('');
    expect(clamp('exact', 5)).toBe('exact');
  });

  it('truncates strings over max length', () => {
    expect(clamp('hello world', 5)).toBe('hello');
    expect(clamp('abcdefghij', 3)).toBe('abc');
  });

  it('handles edge case of max=0', () => {
    expect(clamp('hello', 0)).toBe('');
    expect(clamp('', 0)).toBe('');
  });
});

describe('worker fetch handler', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearPatchCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('health check endpoint', () => {
    it('returns JSON with correct shape', async () => {
      const request = new Request('https://example.com/__seellm/health');
      const env: Env = {};
      const ctx = createMockCtx();

      const response = await worker.fetch(request, env, ctx);
      const body = await response.json() as any;

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(body.ok).toBe(true);
      expect(body.worker).toBe('seellm-site-monitor');
      expect(body.worker_version).toBeDefined();
      expect(body.patch_capabilities).toEqual(expect.arrayContaining([
        'answer_first_block',
        'freshness_update',
        'next_payload_freshness_rewrite',
      ]));
      expect(body.adapter_id).toBeNull();
      expect(body.has_credentials).toBe(false);
      expect(body.timestamp).toBeDefined();
    });

    it('reflects adapter_id and has_credentials when configured', async () => {
      const request = new Request('https://example.com/__seellm/health');
      const env: Env = {
        SEELLM_ADAPTER_ID: 'adapter-123',
        SEELLM_ADAPTER_SECRET: 'secret-abc',
      };
      const ctx = createMockCtx();

      const response = await worker.fetch(request, env, ctx);
      const body = await response.json() as any;

      expect(body.adapter_id).toBe('adapter-123');
      expect(body.has_credentials).toBe(true);
    });

    it('schedules a heartbeat when HMAC credentials are configured', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const request = new Request('https://example.com/__seellm/health');
      const env: Env = {
        SEELLM_ADAPTER_ID: 'adapter-123',
        SEELLM_ADAPTER_SECRET: 'secret-abc',
        SEELLM_ORG_ID: 'org_123',
        SEELLM_API_URL: 'https://api.example.com',
      };
      const ctx = createMockCtx();

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      expect(ctx.waitUntil).toHaveBeenCalledOnce();

      await (ctx.waitUntil as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/api/site-events/heartbeat',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'X-Seellm-Org-Id': 'org_123',
            'X-Seellm-Adapter-Id': 'adapter-123',
          }),
        }),
      );
    });
  });

  describe('unconfigured worker', () => {
    it('passes through to origin when no credentials are set', async () => {
      const originResponse = new Response('Origin content', {
        status: 200,
        headers: { 'X-Origin': 'true' },
      });
      globalThis.fetch = vi.fn().mockResolvedValue(originResponse);

      const request = new Request('https://example.com/page');
      const env: Env = {};
      const ctx = createMockCtx();

      const response = await worker.fetch(request, env, ctx);

      expect(globalThis.fetch).toHaveBeenCalledWith(request);
      expect(response).toBe(originResponse);
      // waitUntil should not be called since we're not monitoring
      expect(ctx.waitUntil).not.toHaveBeenCalled();
    });
  });

  describe('configured worker', () => {
    it('creates events and flushes via waitUntil when API key is set', async () => {
      const originResponse = new Response('Page content', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
      globalThis.fetch = vi.fn().mockResolvedValue(originResponse);

      const request = new Request('https://example.com/blog');
      const env: Env = {
        SEELLM_API_KEY: 'test-api-key',
      };
      const ctx = createMockCtx();

      const response = await worker.fetch(request, env, ctx);

      expect(response).toBe(originResponse);
      // waitUntil should be called for the flush
      expect(ctx.waitUntil).toHaveBeenCalled();
    });

    it('creates events when adapter credentials are set', async () => {
      const originResponse = new Response('Page content', { status: 200 });
      globalThis.fetch = vi.fn().mockResolvedValue(originResponse);

      const request = new Request('https://example.com/about');
      const env: Env = {
        SEELLM_ADAPTER_ID: 'adapter-123',
        SEELLM_ADAPTER_SECRET: 'secret-abc',
        SEELLM_ORG_ID: 'org-456',
      };
      const ctx = createMockCtx();

      const response = await worker.fetch(request, env, ctx);

      expect(response).toBe(originResponse);
      expect(ctx.waitUntil).toHaveBeenCalled();
    });

    it('injects a matching active patch into HTML responses', async () => {
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
        if (url === 'https://api.example.com/api/patches/active') {
          return new Response(JSON.stringify({
            patches: [
              {
                id: 'patch_123',
                url: 'https://example.com/pricing',
                type: 'answer_first_block',
                html: '<section class="seellm-answer-first-patch"><h2>Short answer</h2><p>Pricing starts with a clear answer.</p></section>',
                updated_at: '2026-05-03T12:00:00.000Z',
              },
            ],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        return new Response('<html><body><main><h1>Pricing</h1></main></body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': '56' },
        });
      });

      const request = new Request('https://example.com/pricing?utm=ai');
      const env: Env = {
        SEELLM_ADAPTER_ID: 'adapter-123',
        SEELLM_ADAPTER_SECRET: 'secret-abc',
        SEELLM_ORG_ID: 'org-456',
        SEELLM_API_URL: 'https://api.example.com',
      };
      const ctx = createMockCtx();

      const response = await worker.fetch(request, env, ctx);
      const html = await response.text();

      expect(response.headers.get('Content-Length')).toBeNull();
      expect(html).toContain('data-seellm-patch-id="patch_123"');
      expect(html).toContain('Pricing starts with a clear answer.');
      expect(html.indexOf('Pricing starts with a clear answer.')).toBeLessThan(html.indexOf('<h1>Pricing</h1>'));
    });

    it('applies a freshness patch to article metadata and visible date', async () => {
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
        if (url === 'https://api.example.com/api/patches/active') {
          return new Response(JSON.stringify({
            patches: [
              {
                id: 'patch_freshness',
                url: 'https://example.com/blog/resume-trends',
                type: 'freshness_update',
                html: '<span class="seellm-freshness-update">Updated May 2026</span>',
                payload: {
                  modified_at: '2026-05-04',
                  display_label: 'Updated May 2026',
                },
                updated_at: '2026-05-04T10:00:00.000Z',
              },
            ],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        return new Response(
          [
            '<html><head>',
            '<meta property="article:modified_time" content="2025-07-02">',
            '<script type="application/ld+json">{"@type":"Article","dateModified":"2025-07-02"}</script>',
            '</head><body><article><div class="date">July 2, 2025</div><h1>Resume Trends</h1></article>',
            '<script>self.__next_f.push([1,"{\\"property\\":\\"article:modified_time\\",\\"content\\":\\"2025-07-02\\"}"])</script>',
            '<script>self.__next_f.push([1,"{\\"children\\":\\"July 2, 2025\\"}"])</script>',
            '</body></html>',
          ].join(''),
          {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': '240' },
          },
        );
      });

      const request = new Request('https://example.com/blog/resume-trends');
      const env: Env = {
        SEELLM_ADAPTER_ID: 'adapter-123',
        SEELLM_ADAPTER_SECRET: 'secret-abc',
        SEELLM_ORG_ID: 'org-456',
        SEELLM_API_URL: 'https://api.example.com',
      };
      const ctx = createMockCtx();

      const response = await worker.fetch(request, env, ctx);
      const html = await response.text();

      expect(response.headers.get('Content-Length')).toBeNull();
      expect(response.headers.get('X-Seellm-Patch-Applied')).toBe('patch_freshness');
      expect(html).toContain('data-seellm-patch-id="patch_freshness"');
      expect(html).toContain('property="article:modified_time" content="2026-05-04"');
      expect(html).toContain('\\"property\\":\\"article:modified_time\\",\\"content\\":\\"2026-05-04\\"');
      expect(html).toContain('"dateModified":"2026-05-04"');
      expect(html).toContain('July 2, 2025 · Updated May 2026');
      expect(html).not.toContain('\\"children\\":\\"July 2, 2025\\"');
      expect(html).not.toContain('<h2>Short answer</h2>');
    });

    it('does not fetch or inject patches for non-HTML responses', async () => {
      const originResponse = new Response('png-bytes', {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
      globalThis.fetch = vi.fn().mockResolvedValue(originResponse);

      const request = new Request('https://example.com/logo.png');
      const env: Env = {
        SEELLM_ADAPTER_ID: 'adapter-123',
        SEELLM_ADAPTER_SECRET: 'secret-abc',
        SEELLM_ORG_ID: 'org-456',
        SEELLM_API_URL: 'https://api.example.com',
      };
      const ctx = createMockCtx();

      const response = await worker.fetch(request, env, ctx);

      expect(response).toBe(originResponse);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('serves the original HTML when patch manifest fetch fails', async () => {
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
        if (url === 'https://api.example.com/api/patches/active') {
          return new Response('temporary outage', { status: 503 });
        }

        return new Response('<html><body><h1>Original</h1></body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      });

      const request = new Request('https://example.com/pricing');
      const env: Env = {
        SEELLM_ADAPTER_ID: 'adapter-123',
        SEELLM_ADAPTER_SECRET: 'secret-abc',
        SEELLM_ORG_ID: 'org-456',
        SEELLM_API_URL: 'https://api.example.com',
      };
      const ctx = createMockCtx();

      const response = await worker.fetch(request, env, ctx);

      expect(await response.text()).toBe('<html><body><h1>Original</h1></body></html>');
    });
  });

  describe('citation fragment endpoint', () => {
    it('returns 405 for non-POST requests', async () => {
      const request = new Request('https://example.com/__seellm/citation-fragment', {
        method: 'GET',
      });
      const env: Env = {};
      const ctx = createMockCtx();

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(405);
      expect(await response.text()).toBe('Method Not Allowed');
    });

    it('returns 400 for invalid JSON', async () => {
      const request = new Request('https://example.com/__seellm/citation-fragment', {
        method: 'POST',
        body: 'not json',
        headers: { 'Content-Type': 'application/json' },
      });
      const env: Env = {};
      const ctx = createMockCtx();

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Invalid JSON');
    });

    it('returns 400 for missing fragment or url', async () => {
      const request = new Request('https://example.com/__seellm/citation-fragment', {
        method: 'POST',
        body: JSON.stringify({ fragment: 'some text' }),
        headers: { 'Content-Type': 'application/json' },
      });
      const env: Env = {};
      const ctx = createMockCtx();

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Missing fragment or url');
    });

    it('returns 400 when fragment is missing but url is present', async () => {
      const request = new Request('https://example.com/__seellm/citation-fragment', {
        method: 'POST',
        body: JSON.stringify({ url: 'https://example.com/page' }),
        headers: { 'Content-Type': 'application/json' },
      });
      const env: Env = {};
      const ctx = createMockCtx();

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Missing fragment or url');
    });

    it('returns 400 for non-object payloads', async () => {
      const request = new Request('https://example.com/__seellm/citation-fragment', {
        method: 'POST',
        body: JSON.stringify('just a string'),
        headers: { 'Content-Type': 'application/json' },
      });
      const env: Env = {};
      const ctx = createMockCtx();

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Invalid payload');
    });

    it('clamps fields to their max lengths and forwards to API', async () => {
      const apiResponse = new Response(null, { status: 202 });
      globalThis.fetch = vi.fn().mockResolvedValue(apiResponse);

      const longFragment = 'x'.repeat(600);
      const request = new Request('https://example.com/__seellm/citation-fragment', {
        method: 'POST',
        body: JSON.stringify({
          fragment: longFragment,
          url: 'https://example.com/page',
          source: 'chatgpt',
          selector: '.content p',
        }),
        headers: { 'Content-Type': 'application/json' },
      });
      const env: Env = {
        SEELLM_API_KEY: 'test-key',
      };
      const ctx = createMockCtx();

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(202);
      // Verify the API was called
      expect(globalThis.fetch).toHaveBeenCalled();

      // Inspect the body sent to the API
      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const fetchUrl = fetchCall[0] as string;
      expect(fetchUrl).toContain('/api/citation-fragments');

      const fetchInit = fetchCall[1] as RequestInit;
      const sentBody = JSON.parse(fetchInit.body as string);
      // Fragment should be clamped to 500
      expect(sentBody.fragment.length).toBe(500);
      expect(sentBody.url).toBe('https://example.com/page');
      expect(sentBody.source).toBe('chatgpt');
    });
  });

  describe('ORIGIN_URL rewriting', () => {
    it('rewrites request URL to configured origin', async () => {
      const originResponse = new Response('Origin', { status: 200 });
      globalThis.fetch = vi.fn().mockResolvedValue(originResponse);

      const request = new Request('https://example.com/page');
      const env: Env = {
        SEELLM_API_KEY: 'test-key',
        ORIGIN_URL: 'http://localhost:3000',
      };
      const ctx = createMockCtx();

      await worker.fetch(request, env, ctx);

      // The first call to fetch should be the origin request with rewritten URL
      const firstCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const fetchedRequest = firstCall[0] as Request;
      const fetchedUrl = new URL(fetchedRequest.url);
      expect(fetchedUrl.hostname).toBe('localhost');
      expect(fetchedUrl.port).toBe('3000');
      expect(fetchedUrl.protocol).toBe('http:');
      expect(fetchedUrl.pathname).toBe('/page');
    });
  });

  describe('SEELLM_SITE_DOMAIN', () => {
    it('uses SEELLM_SITE_DOMAIN env var over request hostname', async () => {
      const request = new Request('https://example.com/__seellm/health');
      const env: Env = {
        SEELLM_SITE_DOMAIN: 'custom-domain.com',
      };
      const ctx = createMockCtx();

      // Health check doesn't directly expose siteDomain, but we can verify
      // it doesn't error — the config is used internally
      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
    });
  });
});
