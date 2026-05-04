import type { EventSenderConfig } from './event-sender';
import { sendAdapterRequest } from './event-sender';

type ActivePatch = {
  id: string;
  url: string;
  type: 'answer_first_block' | 'freshness_update';
  html: string;
  payload?: {
    modified_at?: string;
    display_label?: string;
  };
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

  if (patch.type === 'freshness_update') {
    return injectFreshnessPatch(html, patch, marker);
  }

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

function injectFreshnessPatch(html: string, patch: ActivePatch, marker: string): string {
  const modifiedAt = patch.payload?.modified_at;
  const displayLabel = patch.payload?.display_label || (modifiedAt ? `Updated ${modifiedAt}` : '');
  if (!modifiedAt && !displayLabel) return html;

  let patched = html;
  if (modifiedAt) {
    patched = patched.replace(
      /(<meta\b[^>]*(?:property|name)=["']article:modified_time["'][^>]*\bcontent=["'])([^"']*)(["'][^>]*>)/i,
      `$1${escapeAttribute(modifiedAt)}$3`,
    );
    patched = patched.replace(
      /("dateModified"\s*:\s*")([^"]*)(")/g,
      `$1${escapeJsonString(modifiedAt)}$3`,
    );
    patched = patched.replace(
      /(\\?"property\\?"\s*:\s*\\?"article:modified_time\\?"[\s\S]{0,200}?\\?"content\\?"\s*:\s*\\?")([^"\\]*)(\\?")/g,
      `$1${escapeJsonString(modifiedAt)}$3`,
    );
  }

  if (displayLabel) {
    const visibleDate = new RegExp(
      `\\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{1,2},\\s+\\d{4}\\b(?!\\s*·\\s*${escapeRegExp(displayLabel)})`,
      'g',
    );
    patched = patched.replace(visibleDate, (match) => `${match} · ${escapeHtml(displayLabel)}`);
  }

  const bodyOpen = patched.match(/<body\b[^>]*>/i);
  const comment = `\n<!-- ${marker} data-seellm-managed="true" type="freshness_update" -->`;
  if (!bodyOpen || typeof bodyOpen.index !== 'number') {
    return `${comment}\n${patched}`;
  }

  const insertAt = bodyOpen.index + bodyOpen[0].length;
  return `${patched.slice(0, insertAt)}${comment}${patched.slice(insertAt)}`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(value: string): string {
  return escapeAttribute(value).replace(/'/g, '&#39;');
}

function escapeJsonString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
