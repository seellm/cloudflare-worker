# @seellm/cloudflare-worker

AI Traffic Monitor for Cloudflare Workers. Detect and analyze AI crawlers visiting your site.

## Features

- **AI Detection**: Automatically detects ChatGPT, Claude, Perplexity, Gemini, and other AI crawlers
- **Zero Latency Impact**: Detection runs at the edge, async event sending doesn't block responses
- **Response Status Tracking**: See which pages AI finds (200) vs misses (404/500)
- **Rich Analytics**: Track AI traffic by source, page, country, and more

> **Note:** This package ships TypeScript source consumed directly by `wrangler`. No build step needed — just point your `wrangler.toml` at the entry file.

## Quick Start

### 1. Install

```bash
npm install @seellm/cloudflare-worker
```

### 2. Generate Adapter Credentials

In the SeeLLM dashboard, open **Site Monitor → Setup → Cloudflare Workers** and click **Generate Credentials**. Copy the adapter ID, secret, and org ID (the secret is shown once).

### 3. Configure

Copy `wrangler.toml` to your project and update as needed:

```toml
name = "seellm-ai-monitor"
main = "node_modules/@seellm/cloudflare-worker/src/index.ts"
compatibility_date = "2024-12-01"

[vars]
SEELLM_ADAPTER_ID = "adapter_xxx"
SEELLM_ADAPTER_SECRET = "<paste secret>"
SEELLM_ORG_ID = "org_abc123"
SEELLM_API_URL = "https://api.seellm.link"
# Optional: pin a domain if the worker handles multiple hosts
# SEELLM_SITE_DOMAIN = "docs.example.com"
```

> Legacy installs can still use API keys by running `npx wrangler secret put SEELLM_API_KEY`, but adapter credentials unlock health checks, policies, and better security.

### 4. Deploy

```bash
npx wrangler deploy
```

## How It Works

The worker intercepts all requests to your site and:

1. **Detects AI traffic** using:
   - User-Agent patterns (GPTBot, ClaudeBot, PerplexityBot, etc.)
   - ASN matching (known AI provider networks)
   - Referrer analysis (clicks from ChatGPT, Claude, etc.)

2. **Captures request/response data**:
   - Request path and method
   - Response status (200, 404, 500, etc.)
   - Content type and size
   - Geographic location

3. **Sends events to SeeLLM** (async, non-blocking):
   - Batched for efficiency
   - Uses `waitUntil` to not impact response time

## AI Sources Detected

| Source | Detection Method |
|--------|-----------------|
| ChatGPT | User-Agent, ASN, Referrer |
| Claude | User-Agent, ASN, Referrer |
| Perplexity | User-Agent, ASN, Referrer |
| Gemini | User-Agent, Referrer |
| Bing Copilot | User-Agent, ASN, Referrer |
| Google AI Overview | User-Agent, ASN |
| Cursor | User-Agent, Referrer |
| GitHub Copilot | User-Agent, Referrer |
| Phind | User-Agent, Referrer |
| Replit | User-Agent, Referrer |
| Codeium | User-Agent, Referrer |
| Mistral | User-Agent, Referrer |
| HuggingChat | User-Agent, Referrer |
| Applebot | User-Agent |
| Amazonbot | User-Agent |
| Meta AI (meta-externalagent) | User-Agent |
| DuckDuckGo (DuckDuckBot) | User-Agent, Referrer |
| Brave Search | User-Agent, Referrer |
| Kagi | User-Agent, Referrer |
| Poe | Referrer |
| You.com | User-Agent, Referrer |
| Cohere | User-Agent |
| Grok (X.ai) | User-Agent, Referrer |
| Seekr | User-Agent, Referrer |
| Andi | User-Agent, Referrer |
| Komo | User-Agent, Referrer |
| Arc Search | User-Agent, Referrer |

## Configuration Options

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SEELLM_ADAPTER_ID` | Yes | - | Adapter ID from dashboard setup |
| `SEELLM_ADAPTER_SECRET` | Yes | - | Adapter secret (shown once) |
| `SEELLM_ORG_ID` | Yes | - | Your organization ID |
| `SEELLM_API_URL` | No | `https://api.seellm.link` | API endpoint |
| `SEELLM_SITE_DOMAIN` | No | auto-detected | Pin domain if worker handles multiple hosts |

> Legacy: `SEELLM_API_KEY` via `npx wrangler secret put` still works but adapter credentials are recommended.

## Dashboard

View your AI traffic analytics at [seellm.com](https://seellm.com):

- **AI Traffic Overview**: Total AI vs human visits
- **Page Analytics**: Which pages AI visits most
- **Error Analysis**: Pages AI tried but got 404/500 (content gaps!)
- **Source Breakdown**: Traffic by AI platform

## Privacy

- No personally identifiable information (PII) is collected
- IP addresses are not stored
- Only request metadata is captured

## Support

- Documentation: [seellm.com/docs](https://seellm.com/docs)
- Issues: [github.com/seellm/cloudflare-worker](https://github.com/seellm/cloudflare-worker/issues)
- Email: support@seellm.com

## License

MIT
