const ALLOWED_ORIGINS = new Set([
  "https://haochen05024.github.io",
  "http://localhost:8788",
  "http://localhost:5173",
]);

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://haochen05024.github.io",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
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


const BOOKING_STATUSES = new Set(["pending", "confirmed", "completed", "cancelled"]);

function makeBookingId() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `BS-${stamp}-${rand}`;
}

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

async function listBookings(env, url) {
  const status = clean(url.searchParams.get("status"), 30).toLowerCase();
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  let query = `SELECT id, customer_name, phone, service, price, duration, booking_date, booking_time, inspiration, customer_note, status, created_at, updated_at FROM bookings`;
  const binds = [];
  if (BOOKING_STATUSES.has(status)) {
    query += ` WHERE status = ?`;
    binds.push(status);
  }
  query += ` ORDER BY booking_date ASC, booking_time ASC, created_at DESC LIMIT ? OFFSET ?`;
  binds.push(limit, offset);
  const result = await env.DB.prepare(query).bind(...binds).all();
  return { data: result.results || [], count: (result.results || []).length };
}

async function getBooking(env, id) {
  const row = await env.DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(id).first();
  return row || null;
}

async function createBooking(env, body) {
  const customerName = clean(body.customerName || body.name, 120);
  const phone = clean(body.phone, 80);
  const service = clean(body.service, 160);
  const bookingDate = clean(body.bookingDate || body.date, 20);
  const bookingTime = clean(body.bookingTime || body.time, 10);
  if (!customerName || customerName.length < 2) throw new Error("Customer name is required");
  if (!phone || phone.replace(/\D/g, "").length < 7) throw new Error("Valid phone is required");
  if (!service) throw new Error("Service is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)) throw new Error("Valid booking date is required");
  if (!/^\d{2}:\d{2}$/.test(bookingTime)) throw new Error("Valid booking time is required");

  // Validate against the same D1 rules used by the customer UI so requests
  // cannot bypass a paused studio or choose a time outside business hours.
  const rulesRow = await env.DB.prepare(`SELECT data FROM booking_rules WHERE id = 1`).first();
  let rules = {};
  try { rules = rulesRow?.data ? JSON.parse(rulesRow.data) : {}; } catch {}
  if (String(rules.status || "open").toLowerCase() !== "open") throw new Error("Online booking is currently paused");
  const [yy, mm, dd] = bookingDate.split("-").map(Number);
  const selected = new Date(yy, mm - 1, dd, 12, 0, 0, 0);
  if (!Number.isFinite(selected.getTime())) throw new Error("Invalid booking date");
  const today = new Date(); today.setHours(0,0,0,0);
  const maxDate = new Date(today); maxDate.setDate(maxDate.getDate() + Math.max(0, Number(rules.advanceDays) || 30));
  if (selected < today || selected > maxDate) throw new Error("Booking date is outside the available window");
  const weekday = selected.getDay() === 0 ? 7 : selected.getDay();
  const workingDays = Array.isArray(rules.workingDays) && rules.workingDays.length ? rules.workingDays.map(Number) : [1,2,3,4,5,6];
  if (!workingDays.includes(weekday)) throw new Error("The Studio is closed on this day");
  const [bh, bm] = bookingTime.split(":").map(Number);
  const selectedMinutes = bh * 60 + bm;
  const openingMinutes = String(rules.openingTime || "10:00").split(":").map(Number).reduce((a,v,i)=>a + v * (i===0?60:1), 0);
  const closingMinutes = String(rules.closingTime || "18:00").split(":").map(Number).reduce((a,v,i)=>a + v * (i===0?60:1), 0);
  const slotMinutes = Math.max(1, Number(rules.slotMinutes) || 30);
  if (selectedMinutes < openingMinutes || selectedMinutes >= closingMinutes || ((selectedMinutes - openingMinutes) % slotMinutes !== 0)) throw new Error("Selected time is not available");
  const lead = Math.max(0, Number(rules.minLeadMinutes) || 0);
  const selectedDateTime = new Date(yy, mm - 1, dd, bh, bm, 0, 0);
  if (selectedDateTime.getTime() < Date.now() + lead * 60000) throw new Error("Selected time requires more advance notice");

  // Prevent two active requests from taking the same studio slot.
  const conflict = await env.DB.prepare(`SELECT id FROM bookings WHERE booking_date = ? AND booking_time = ? AND status IN ('pending','confirmed') LIMIT 1`).bind(bookingDate, bookingTime).first();
  if (conflict) throw new Error("That time has already been requested. Please choose another time");

  const id = makeBookingId();
  const now = new Date().toISOString();
  const record = {
    id,
    customerName,
    phone,
    service,
    price: clean(body.price, 80),
    duration: clean(body.duration, 40),
    bookingDate,
    bookingTime,
    inspiration: clean(body.inspiration, 300),
    customerNote: clean(body.customerNote || body.note, 500),
    status: "pending",
    createdAt: now,
    updatedAt: now
  };
  await env.DB.prepare(`INSERT INTO bookings
    (id, customer_name, phone, service, price, duration, booking_date, booking_time, inspiration, customer_note, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .bind(id, record.customerName, record.phone, record.service, record.price, record.duration,
      record.bookingDate, record.bookingTime, record.inspiration, record.customerNote, now, now).run();
  return record;
}

async function updateBooking(env, id, body) {
  const status = clean(body.status, 30).toLowerCase();
  if (!BOOKING_STATUSES.has(status)) throw new Error("Invalid booking status");
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?`).bind(status, now, id).run();
  if (!result.meta || result.meta.changes !== 1) return null;
  return getBooking(env, id);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/health" && request.method === "GET") {
        return json({ ok:true, service:"beauty-studio-api", database:"beauty-studio-db", storage:"D1 only", time:new Date().toISOString() }, 200, request);
      }

      // Public customer booking submission. No admin token is exposed to the customer site.
      if (path === "/api/bookings" && request.method === "POST") {
        const length = Number(request.headers.get("Content-Length") || 0);
        if (length && length > 20000) return json({ ok:false, error:"Request too large" }, 413, request);
        let body;
        try { body = await request.json(); } catch { return json({ ok:false, error:"Invalid JSON" }, 400, request); }
        try {
          const booking = await createBooking(env, body || {});
          return json({ ok:true, booking }, 201, request);
        } catch (error) {
          return json({ ok:false, error:error.message || String(error) }, 400, request);
        }
      }

      // Admin-only booking management.
      if (path === "/api/bookings" || path.startsWith("/api/bookings/")) {
        if (!env.ADMIN_TOKEN || request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) {
          return json({ ok:false, error:"Unauthorized" }, 401, request);
        }
        if (path === "/api/bookings" && request.method === "GET") {
          return json({ ok:true, ...(await listBookings(env, url)) }, 200, request);
        }
        const id = decodeURIComponent(path.slice("/api/bookings/".length));
        if (!id) return json({ ok:false, error:"Booking id required" }, 400, request);
        if (request.method === "GET") {
          const booking = await getBooking(env, id);
          return booking ? json({ ok:true, booking }, 200, request) : json({ ok:false, error:"Not found" }, 404, request);
        }
        if (request.method === "PUT") {
          let body; try { body = await request.json(); } catch { return json({ ok:false, error:"Invalid JSON" }, 400, request); }
          try {
            const booking = await updateBooking(env, id, body || {});
            return booking ? json({ ok:true, booking }, 200, request) : json({ ok:false, error:"Not found" }, 404, request);
          } catch (error) { return json({ ok:false, error:error.message || String(error) }, 400, request); }
        }
        if (request.method === "DELETE") {
          const result = await env.DB.prepare(`DELETE FROM bookings WHERE id = ?`).bind(id).run();
          return result.meta?.changes === 1 ? json({ ok:true }, 200, request) : json({ ok:false, error:"Not found" }, 404, request);
        }
        return json({ ok:false, error:"Method not allowed" }, 405, request);
      }

      if (!routes[path]) return json({ ok:false, error:"Not found" }, 404, request);
      const [table, id] = routes[path];
      if (request.method === "GET") return json({ ok:true, ...(await getRow(env, table, id)) }, 200, request);
      if (request.method === "PUT") {
        if (!env.ADMIN_TOKEN || request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) return json({ ok:false, error:"Unauthorized" }, 401, request);
        let body; try { body = await request.json(); } catch { return json({ ok:false, error:"Invalid JSON" }, 400, request); }
        const data = Object.prototype.hasOwnProperty.call(body, "data") ? body.data : body;
        return json({ ok:true, ...(await saveRow(env, table, id, data)) }, 200, request);
      }
      return json({ ok:false, error:"Method not allowed" }, 405, request);
    } catch (error) {
      return json({ ok:false, error:error.message || String(error) }, 500, request);
    }
  }
};
