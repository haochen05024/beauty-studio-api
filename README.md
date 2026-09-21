# Beauty Studio API v1

Separate Cloudflare Worker for the customer site + admin panel.

Architecture:

Customer website
    ↓
beauty-studio-api
    ├── R2 → beauty-studio-media
    └── D1 → beauty-studio-db

## 1. Create resources

Install Wrangler and log in:

```bash
npx wrangler login
```

Create R2:

```bash
npx wrangler r2 bucket create beauty-studio-media
```

Create D1:

```bash
npx wrangler d1 create beauty-studio-db
```

Copy the returned D1 database ID into `wrangler.jsonc`.

## 2. Initialize D1

```bash
npx wrangler d1 execute beauty-studio-db --remote --file=./schema.sql
```

## 3. Set the admin secret

Do NOT put this secret in GitHub or frontend JavaScript.

```bash
npx wrangler secret put ADMIN_TOKEN
```

## 4. Deploy

```bash
npx wrangler deploy
```

## 5. Test

Open:

```text
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/health
```

Expected:

```json
{
  "ok": true,
  "service": "beauty-studio-api",
  "r2": true,
  "d1": true,
  "version": "v1"
}
```

## Important security note

The write endpoints require `x-admin-token`. Do not expose that token in the public
customer website. The next admin iteration should use Cloudflare Access/session-based
authentication rather than shipping a permanent token in browser code.

CORS is intentionally restrictive. Replace `YOUR_GITHUB_USERNAME` in `src/index.js`
with the real GitHub Pages owner/origin before production use.

Cloudflare bindings give the Worker direct access to R2 and D1 without exposing
provider API keys to the application code.
