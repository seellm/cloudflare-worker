import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createSiteEvent, queueEvent, flushEvents } from '../src/event-sender';

describe('createSiteEvent', () => {
  it('extracts path, method, timestamp, and status', () => {
    const request = new Request('https://example.com/blog/post?page=2', {
      method: 'GET',
    });
    const response = new Response('OK', { status: 200 });

    const event = createSiteEvent(request, response);

    expect(event.path).toBe('/blog/post?page=2');
    expect(event.method).toBe('GET');
    expect(event.status).toBe(200);
    expect(event.timestamp).toBeDefined();
    // Verify timestamp is a valid ISO string
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
  });

  it('extracts user-agent, accept, and referrer from headers', () => {
    const request = new Request('https://example.com/', {
      method: 'GET',
      headers: {
        'User-Agent': 'GPTBot/1.0',
        'Accept': 'text/html',
        'Referer': 'https://google.com/search',
      },
    });
    const response = new Response('OK', { status: 200 });

    const event = createSiteEvent(request, response);

    expect(event.ua).toBe('GPTBot/1.0');
    expect(event.accept).toBe('text/html');
    expect(event.referrer).toBe('https://google.com/search');
  });

  it('extracts content-type and content-length from response headers', () => {
    const request = new Request('https://example.com/');
    const response = new Response('Hello', {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': '5',
      },
    });

    const event = createSiteEvent(request, response);

    expect(event.content_type).toBe('text/html; charset=utf-8');
    expect(event.content_length).toBe(5);
  });

  it('passes ASN from argument', () => {
    const request = new Request('https://example.com/');
    const response = new Response('OK', { status: 200 });

    const event = createSiteEvent(request, response, '13335');

    expect(event.asn).toBe('13335');
  });

  it('extracts geographic data from cf object', () => {
    const request = new Request('https://example.com/');
    (request as any).cf = {
      country: 'US',
      city: 'San Francisco',
      regionCode: 'CA',
      timezone: 'America/Los_Angeles',
      continent: 'NA',
      asn: 13335,
    };
    const response = new Response('OK', { status: 200 });

    const event = createSiteEvent(request, response);

    expect(event.country).toBe('US');
    expect(event.city).toBe('San Francisco');
    expect(event.region).toBe('CA');
    expect(event.timezone).toBe('America/Los_Angeles');
    expect(event.continent).toBe('NA');
  });

  it('handles missing optional fields gracefully', () => {
    const request = new Request('https://example.com/');
    const response = new Response(null, { status: 204 });

    const event = createSiteEvent(request, response);

    expect(event.ua).toBeUndefined();
    expect(event.accept).toBeUndefined();
    expect(event.country).toBeUndefined();
    expect(event.referrer).toBeUndefined();
    expect(event.asn).toBeUndefined();
    expect(event.city).toBeUndefined();
    expect(event.region).toBeUndefined();
    expect(event.timezone).toBeUndefined();
    expect(event.continent).toBeUndefined();
    expect(event.content_length).toBeUndefined();
  });

  it('handles missing cf object', () => {
    const request = new Request('https://example.com/');
    // cf is not set at all (standard Request, not Cloudflare)
    const response = new Response('OK', { status: 200 });

    const event = createSiteEvent(request, response);

    expect(event.country).toBeUndefined();
    expect(event.city).toBeUndefined();
    expect(event.region).toBeUndefined();
    expect(event.timezone).toBeUndefined();
    expect(event.continent).toBeUndefined();
  });

  it('handles POST requests with different status codes', () => {
    const request = new Request('https://example.com/api/data', {
      method: 'POST',
    });
    const response = new Response('Not Found', { status: 404 });

    const event = createSiteEvent(request, response);

    expect(event.method).toBe('POST');
    expect(event.status).toBe(404);
    expect(event.path).toBe('/api/data');
  });

  it('extracts path with complex query strings', () => {
    const request = new Request(
      'https://example.com/search?q=hello+world&lang=en&page=1'
    );
    const response = new Response('OK', { status: 200 });

    const event = createSiteEvent(request, response);

    expect(event.path).toBe('/search?q=hello+world&lang=en&page=1');
  });
});

describe('queueEvent', () => {
  let mockCtx: ExecutionContext;

  beforeEach(() => {
    mockCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
  });

  it('queues an event without immediate flush when under batch size', () => {
    const event = createSiteEvent(
      new Request('https://example.com/'),
      new Response('OK', { status: 200 })
    );
    const config = {
      apiUrl: 'https://api.seellm.link',
      apiKey: 'test-key',
      siteDomain: 'example.com',
    };

    queueEvent(event, config, mockCtx);

    // waitUntil should not be called for a single event (below batch size)
    expect(mockCtx.waitUntil).not.toHaveBeenCalled();
  });
});

describe('flushEvents', () => {
  let mockCtx: ExecutionContext;

  beforeEach(() => {
    mockCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
  });

  it('flushes queued events via waitUntil', () => {
    const config = {
      apiUrl: 'https://api.seellm.link',
      apiKey: 'test-key',
      siteDomain: 'example.com',
    };

    // Queue an event first
    const event = createSiteEvent(
      new Request('https://example.com/'),
      new Response('OK', { status: 200 })
    );
    queueEvent(event, config, mockCtx);

    // Now flush should call waitUntil to send the queued event
    const flushCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    flushEvents(config, flushCtx);

    expect(flushCtx.waitUntil).toHaveBeenCalledOnce();
  });

  it('does nothing when batch is already empty (after a flush)', () => {
    const config = {
      apiUrl: 'https://api.seellm.link',
      apiKey: 'test-key',
      siteDomain: 'example.com',
    };

    // Flush once to clear any previously queued events from other tests
    const clearCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    flushEvents(config, clearCtx);

    // Now flush again on a fresh mock — should do nothing
    const freshCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    flushEvents(config, freshCtx);

    expect(freshCtx.waitUntil).not.toHaveBeenCalled();
  });
});
