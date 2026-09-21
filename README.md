# Beauty Studio API v1.1 — D1 Only

R2 is intentionally omitted for now. It can be added later.

D1 database: beauty-studio-db
Database ID: cb703149-01cf-4881-a8e3-3d051b4ecf96

Endpoints:
GET  /health
GET  /api/content/settings
PUT  /api/content/settings
GET  /api/content/services
PUT  /api/content/services
GET  /api/content/gallery
PUT  /api/content/gallery
GET  /api/content/booking-rules
PUT  /api/content/booking-rules

PUT requests require the Worker secret ADMIN_TOKEN.
Never put ADMIN_TOKEN into GitHub.
