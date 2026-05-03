import type { EventSenderConfig } from './event-sender';
import { sendAdapterRequest } from './event-sender';

type ActivePatch = {
  id: string;
  url: string;
  type: 'answer_first_block';
  html: string;
  updated_at: string;
};

type ActivePatchResponse = {
  patches?: ActivePatch[];
};

const PATCH_REFRESH_MS = 60 * 1000;

let cachedManifest: { key: string; patches: ActivePatch[]; fetchedAt: number } | null = null;

export function clearPatchCache(): void {
  cachedManifest = null;
}

export async function applyVisibilityPatches(
  request: Request,
  response: Response,
  config: EventSenderConfig,
): Promise<Response> {
  if (!canPatchRequest(request, response, config)) {
    return response;
  }

  let patches: ActivePatch[];
  try {
    patches = await getActivePatches(config);
  } catch (error) {
    console.warn('[SeeLLM] Patch manifest unavailable, serving origin response', error);
    return response;
  }

  const patch = patches.find((candidate) => patchMatchesRequest(candidate, request.url));
  if (!patch) {
    return response;
  }

  try {
    const originalHtml = await response.text();
    const patchedHtml = injectPatchHtml(originalHtml, patch);
    if (patchedHtml === originalHtml) {
      return new Response(originalHtml, response);
    }

    const headers = new Headers(response.headers);
    headers.delete('Content-Length');
    headers.set('X-Seellm-Patch-Applied', patch.id);
    return new Response(patchedHtml, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    console.warn('[SeeLLM] Patch injection failed, serving origin response', error);
    return response;
  }
}

async function getActivePatches(config: EventSenderConfig): Promise<ActivePatch[]> {
  const key = `${config.apiUrl}|${config.orgId || ''}|${config.siteDomain}`;
  if (cachedManifest && cachedManifest.key === key && Date.now() - cachedManifest.fetchedAt < PATCH_REFRESH_MS) {
    return cachedManifest.patches;
  }

  const response = await sendAdapterRequest(config, '/api/patches/active', {
    method: 'GET',
  });
  if (!response.ok) {
    throw new Error(`Patch manifest failed: ${response.status}`);
  }

  const manifest = (await response.json()) as ActivePatchResponse;
  const patches = Array.isArray(manifest.patches) ? manifest.patches : [];
  cachedManifest = { key, patches, fetchedAt: Date.now() };
  return patches;
}

function canPatchRequest(request: Request, response: Response, config: EventSenderConfig): boolean {
  if (request.method !== 'GET') return false;
  if (!config.adapterId || !config.adapterSecret || !config.orgId) return false;
  if (response.status < 200 || response.status >= 300) return false;
  const contentType = response.headers.get('Content-Type') || '';
  return contentType.toLowerCase().includes('text/html');
}

function patchMatchesRequest(patch: ActivePatch, requestUrl: string): boolean {
  try {
    const current = new URL(requestUrl);
    const target = new URL(patch.url, current.origin);
    return normalizeUrlForMatch(current) === normalizeUrlForMatch(target);
  } catch {
    return false;
  }
}

function normalizeUrlForMatch(url: URL): string {
  const pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '');
  return `${url.hostname.toLowerCase()}${pathname}`;
}

function injectPatchHtml(html: string, patch: ActivePatch): string {
  const marker = `data-seellm-patch-id="${escapeAttribute(patch.id)}"`;
  if (html.includes(marker)) return html;

  const block = [
    `<div ${marker} data-seellm-managed="true">`,
    patch.html,
    '</div>',
  ].join('\n');

  const bodyOpen = html.match(/<body\b[^>]*>/i);
  if (!bodyOpen || typeof bodyOpen.index !== 'number') {
    return `${block}\n${html}`;
  }

  const insertAt = bodyOpen.index + bodyOpen[0].length;
  return `${html.slice(0, insertAt)}\n${block}\n${html.slice(insertAt)}`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
