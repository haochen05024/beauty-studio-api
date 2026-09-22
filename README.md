# Beauty Studio API v5 — Need Help Chat

Cloudflare Worker API for Beauty Studio.

Adds persistent Need Help chat conversations tied to the existing anonymous customer browser identity / Customer Number system.

New customer endpoints:
- `GET /api/support/conversation`
- `POST /api/support/messages`
- `POST /api/support/read`

New admin endpoints (ADMIN_TOKEN required):
- `GET /api/support/conversations`
- `GET /api/support/conversations/:id`
- `POST /api/support/conversations/:id/messages`
- `PUT /api/support/conversations/:id`

The customer browser key remains the persistent identity. IP is not used as the primary customer identifier.
