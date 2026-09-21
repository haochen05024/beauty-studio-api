const ALLOWED_ORIGINS = new Set([
  "https://haochen05024.github.io",
  "http://localhost:8788",
  "http://localhost:5173",
]);

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://haochen05024.github.io",
    "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-token",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(data, status, request) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(request) },
  });
}

const routes = {
  "/api/content/settings": ["studio_settings", 1],
  "/api/content/services": ["services", "all"],
  "/api/content/gallery": ["gallery", "all"],
  "/api/content/booking-rules": ["booking_rules", 1],
};

async function getRow(env, table, id) {
  const row = await env.DB.prepare(
    `SELECT data, updated_at FROM ${table} WHERE id = ?`
  ).bind(id).first();
  if (!row) return { data: null, updatedAt: null };
  let data;
  try { data = JSON.parse(row.data); } catch { data = row.data; }
  return { data, updatedAt: row.updated_at };
}

async function saveRow(env, table, id, data) {
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO ${table} (id, data, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).bind(id, JSON.stringify(data), updatedAt).run();
  return { data, updatedAt };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/health" && request.method === "GET") {
        return json({
          ok: true,
          service: "beauty-studio-api",
          database: "beauty-studio-db",
          storage: "D1 only",
          time: new Date().toISOString()
        }, 200, request);
      }

      if (!routes[path]) return json({ ok: false, error: "Not found" }, 404, request);

      const [table, id] = routes[path];

      if (request.method === "GET") {
        return json({ ok: true, ...(await getRow(env, table, id)) }, 200, request);
      }

      if (request.method === "PUT") {
        if (!env.ADMIN_TOKEN || request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) {
          return json({ ok: false, error: "Unauthorized" }, 401, request);
        }

        let body;
        try { body = await request.json(); }
        catch { return json({ ok: false, error: "Invalid JSON" }, 400, request); }

        const data = Object.prototype.hasOwnProperty.call(body, "data") ? body.data : body;
        return json({ ok: true, ...(await saveRow(env, table, id, data)) }, 200, request);
      }

      return json({ ok: false, error: "Method not allowed" }, 405, request);
    } catch (error) {
      return json({ ok: false, error: error.message || String(error) }, 500, request);
    }
  }
};
