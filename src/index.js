const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "cache-control": "no-store",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

function cors(origin) {
  // Keep this narrow in production. During setup, replace with the exact
  // beauty-studio and beauty-studio-admin origins.
  const allowed = [
    "https://YOUR_GITHUB_USERNAME.github.io",
    "http://localhost:8788",
    "http://localhost:5173",
  ];
  return allowed.includes(origin) ? origin : "";
}

function withCors(response, origin) {
  const out = new Response(response.body, response);
  const allow = cors(origin);
  if (allow) {
    out.headers.set("access-control-allow-origin", allow);
    out.headers.set("access-control-allow-methods", "GET,PUT,DELETE,OPTIONS");
    out.headers.set("access-control-allow-headers", "content-type,x-admin-token");
    out.headers.set("vary", "Origin");
  }
  return out;
}

function authorized(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  return request.headers.get("x-admin-token") === expected;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "";

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), origin);
    }

    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return withCors(json({
          ok: true,
          service: "beauty-studio-api",
          r2: Boolean(env.MEDIA),
          d1: Boolean(env.DB),
          version: "v1",
        }), origin);
      }

      // ---------- R2 media ----------
      if (url.pathname === "/api/media" && request.method === "GET") {
        const prefix = url.searchParams.get("prefix") || "";
        const listed = await env.MEDIA.list({ prefix, limit: 1000 });
        return withCors(json({
          ok: true,
          objects: listed.objects.map(o => ({
            key: o.key,
            size: o.size,
            uploaded: o.uploaded,
            etag: o.etag,
          })),
          truncated: listed.truncated,
        }), origin);
      }

      if (url.pathname.startsWith("/api/media/")) {
        if (!authorized(request, env)) {
          return withCors(json({ ok: false, error: "Unauthorized" }, 401), origin);
        }

        const key = decodeURIComponent(url.pathname.slice("/api/media/".length));
        if (!key || key.includes("..")) {
          return withCors(json({ ok: false, error: "Invalid media key" }, 400), origin);
        }

        if (request.method === "PUT") {
          const contentType = request.headers.get("content-type") || "application/octet-stream";
          const body = request.body;
          if (!body) {
            return withCors(json({ ok: false, error: "Missing file body" }, 400), origin);
          }

          const object = await env.MEDIA.put(key, body, {
            httpMetadata: { contentType },
          });

          return withCors(json({
            ok: true,
            key,
            etag: object?.etag || null,
          }), origin);
        }

        if (request.method === "DELETE") {
          await env.MEDIA.delete(key);
          return withCors(json({ ok: true, key }), origin);
        }
      }

      // ---------- D1 content ----------
      const contentMatch = url.pathname.match(/^\/api\/content\/(settings|services|gallery|booking-rules)$/);
      if (contentMatch) {
        const type = contentMatch[1];
        const table = {
          "settings": "studio_settings",
          "services": "services",
          "gallery": "gallery",
          "booking-rules": "booking_rules",
        }[type];

        if (request.method === "GET") {
          const rows = await env.DB.prepare(
            `SELECT * FROM ${table} ORDER BY updated_at DESC`
          ).all();
          return withCors(json({ ok: true, type, rows: rows.results || [] }), origin);
        }

        if (!authorized(request, env)) {
          return withCors(json({ ok: false, error: "Unauthorized" }, 401), origin);
        }

        if (request.method === "PUT") {
          const payload = await readJson(request);
          if (!payload) {
            return withCors(json({ ok: false, error: "Invalid JSON" }, 400), origin);
          }

          const now = new Date().toISOString();

          if (type === "settings" || type === "booking-rules") {
            const id = 1;
            await env.DB.prepare(
              `INSERT INTO ${table} (id, data, updated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
            ).bind(id, JSON.stringify(payload), now).run();
          } else {
            if (!payload.id) {
              return withCors(json({ ok: false, error: "Missing id" }, 400), origin);
            }
            await env.DB.prepare(
              `INSERT INTO ${table} (id, data, updated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
            ).bind(String(payload.id), JSON.stringify(payload), now).run();
          }

          return withCors(json({ ok: true, type, updated_at: now }), origin);
        }
      }

      return withCors(json({ ok: false, error: "Not found" }, 404), origin);
    } catch (error) {
      return withCors(json({
        ok: false,
        error: error instanceof Error ? error.message : "Server error",
      }, 500), origin);
    }
  },
};
