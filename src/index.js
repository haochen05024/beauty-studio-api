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
    "Access-Control-Allow-Headers": "Content-Type, x-admin-token, x-customer-key",
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



async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function getClientIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "";
}

function getCustomerKey(request, body = {}) {
  return clean(body.customerKey || request.headers.get("x-customer-key"), 120);
}

async function identifyCustomer(env, request, body = {}) {
  const browserKey = getCustomerKey(request, body);
  if (!browserKey || browserKey.length < 16) throw new Error("Customer key is required");
  const now = new Date().toISOString();
  const ipHash = await sha256Hex(getClientIp(request));
  const ua = clean(request.headers.get("User-Agent"), 500);
  const name = clean(body.name, 120);
  const phone = clean(body.phone, 80);

  let customer = await env.DB.prepare(`SELECT * FROM customers WHERE browser_key = ?`).bind(browserKey).first();
  if (customer) {
    await env.DB.prepare(`UPDATE customers SET name = COALESCE(NULLIF(?, ''), name), phone = COALESCE(NULLIF(?, ''), phone), last_seen = ?, last_ip_hash = ?, user_agent = ? WHERE browser_key = ?`)
      .bind(name, phone, now, ipHash, ua, browserKey).run();
    customer = await env.DB.prepare(`SELECT * FROM customers WHERE browser_key = ?`).bind(browserKey).first();
    return { customerNumber: customer.customer_number, firstSeen: customer.first_seen, lastSeen: customer.last_seen };
  }

  // AUTOINCREMENT id is the authoritative sequence. Public customer number is 0001, 0002...
  const inserted = await env.DB.prepare(`INSERT INTO customers (customer_number, browser_key, name, phone, first_seen, last_seen, last_ip_hash, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(`TEMP-${browserKey}`, browserKey, name, phone, now, now, ipHash, ua).first();
  const id = Number(inserted?.id || 0);
  if (!id) throw new Error("Could not create customer");
  const customerNumber = String(id).padStart(4, "0");
  await env.DB.prepare(`UPDATE customers SET customer_number = ? WHERE id = ?`).bind(customerNumber, id).run();
  return { customerNumber, firstSeen: now, lastSeen: now };
}

async function getCustomerByKey(env, browserKey) {
  if (!browserKey) return null;
  return env.DB.prepare(`SELECT * FROM customers WHERE browser_key = ?`).bind(browserKey).first();
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
  let query = `SELECT id, customer_number, customer_name, phone, service, price, duration, booking_date, booking_time, inspiration, customer_note, status, created_at, updated_at FROM bookings`;
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
  const customerBrowserKey = clean(body.customerKey, 120);
  if (!customerBrowserKey || customerBrowserKey.length < 16) throw new Error("Customer identity is required");
  const customer = await getCustomerByKey(env, customerBrowserKey);
  if (!customer) throw new Error("Customer identity is not registered");

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
    customerNumber: customer.customer_number,
    customerKey: customerBrowserKey,
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
    (id, customer_number, customer_browser_key, customer_name, phone, service, price, duration, booking_date, booking_time, inspiration, customer_note, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .bind(id, record.customerNumber, record.customerKey, record.customerName, record.phone, record.service, record.price, record.duration,
      record.bookingDate, record.bookingTime, record.inspiration, record.customerNote, now, now).run();
  return record;
}


async function createNotification(env, { customerBrowserKey, customerNumber, bookingId, type, title, message }) {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`INSERT INTO notifications
    (customer_browser_key, customer_number, booking_id, type, title, message, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)`)
    .bind(customerBrowserKey, customerNumber, bookingId || null, type, title, message, now).run();
  return { id: result.meta?.last_row_id || null, createdAt: now };
}

async function notifyBookingStatus(env, previous, booking) {
  if (!previous || previous.status === booking.status) return;
  const status = String(booking.status || '').toLowerCase();
  const customerBrowserKey = booking.customer_browser_key || booking.customerBrowser_key || previous.customer_browser_key || previous.customer_browser_key;
  const customerNumber = booking.customer_number || previous.customer_number || '';
  if (!customerBrowserKey) return;

  const copy = {
    confirmed: {
      type: 'booking_confirmed',
      title: 'Appointment confirmed',
      message: `${booking.service || 'Your appointment'} · ${booking.booking_date || ''} · ${booking.booking_time || ''}`
    },
    cancelled: {
      type: 'booking_cancelled',
      title: 'Appointment update',
      message: `${booking.service || 'Your appointment'} was cancelled. Please contact the Studio if you need help.`
    },
    completed: {
      type: 'booking_completed',
      title: 'Appointment completed',
      message: `${booking.service || 'Your appointment'} has been marked completed. Thank you for visiting us.`
    },
    pending: {
      type: 'booking_pending',
      title: 'Appointment received',
      message: `${booking.service || 'Your appointment'} is awaiting Studio confirmation.`
    }
  }[status];
  if (copy) await createNotification(env, { customerBrowserKey, customerNumber, bookingId: booking.id, ...copy });
}

async function listCustomerNotifications(env, key, unreadOnly = false) {
  let query = `SELECT id, customer_number, booking_id, type, title, message, is_read, created_at FROM notifications WHERE customer_browser_key = ?`;
  if (unreadOnly) query += ` AND is_read = 0`;
  query += ` ORDER BY created_at DESC, id DESC LIMIT 50`;
  const result = await env.DB.prepare(query).bind(key).all();
  return result.results || [];
}

async function markCustomerNotificationsRead(env, key, ids = []) {
  if (ids.length) {
    const cleanIds = ids.map(Number).filter(Number.isInteger).filter(id => id > 0).slice(0, 50);
    if (cleanIds.length) {
      const placeholders = cleanIds.map(() => '?').join(',');
      await env.DB.prepare(`UPDATE notifications SET is_read = 1 WHERE customer_browser_key = ? AND id IN (${placeholders})`)
        .bind(key, ...cleanIds).run();
    }
  } else {
    await env.DB.prepare(`UPDATE notifications SET is_read = 1 WHERE customer_browser_key = ?`).bind(key).run();
  }
}

async function updateBooking(env, id, body) {
  const status = clean(body.status, 30).toLowerCase();
  if (!BOOKING_STATUSES.has(status)) throw new Error("Invalid booking status");
  const previous = await getBooking(env, id);
  if (!previous) return null;
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?`).bind(status, now, id).run();
  if (!result.meta || result.meta.changes !== 1) return null;
  const booking = await getBooking(env, id);
  await notifyBookingStatus(env, previous, booking);
  return booking;
}


async function ensureSupportConversation(env, customer) {
  let row = await env.DB.prepare(`SELECT * FROM support_conversations WHERE customer_browser_key = ?`).bind(customer.browser_key).first();
  if (row) return row;
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`INSERT INTO support_conversations (customer_browser_key, customer_number, status, unread_customer, unread_admin, created_at, updated_at) VALUES (?, ?, 'open', 0, 0, ?, ?) RETURNING id`)
    .bind(customer.browser_key, customer.customer_number, now, now).first();
  return env.DB.prepare(`SELECT * FROM support_conversations WHERE id = ?`).bind(Number(result.id)).first();
}

async function listSupportMessages(env, conversationId) {
  const result = await env.DB.prepare(`SELECT id, conversation_id, sender_type, sender_name, message, created_at FROM support_messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 200`).bind(conversationId).all();
  return result.results || [];
}

async function addSupportMessage(env, conversation, senderType, message, senderName) {
  const cleanMessage = clean(message, 2000);
  if (!cleanMessage) throw new Error('Message is empty');
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`INSERT INTO support_messages (conversation_id, sender_type, sender_name, message, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id`)
    .bind(conversation.id, senderType, clean(senderName, 120), cleanMessage, now).first();
  const unreadCustomer = senderType === 'admin' ? 1 : 0;
  const unreadAdmin = senderType === 'customer' ? 1 : 0;
  await env.DB.prepare(`UPDATE support_conversations SET unread_customer = ?, unread_admin = ?, updated_at = ? WHERE id = ?`)
    .bind(unreadCustomer ? 1 : 0, unreadAdmin ? 1 : 0, now, conversation.id).run();
  if (senderType === 'admin') {
    await createNotification(env, {
      customerBrowserKey: conversation.customer_browser_key,
      customerNumber: conversation.customer_number,
      bookingId: null,
      type: 'support_message',
      title: 'New message from Beauty Studio',
      message: cleanMessage.slice(0, 180)
    });
  }
  return env.DB.prepare(`SELECT id, conversation_id, sender_type, sender_name, message, created_at FROM support_messages WHERE id = ?`).bind(Number(result.id)).first();
}

async function getSupportConversationForCustomer(env, key) {
  const customer = await getCustomerByKey(env, key);
  if (!customer) return null;
  const conversation = await env.DB.prepare(`SELECT * FROM support_conversations WHERE customer_browser_key = ?`).bind(key).first();
  const messages = conversation ? await listSupportMessages(env, conversation.id) : [];
  return { customerNumber: customer.customer_number, conversation: conversation || { id:null, customer_number:customer.customer_number, status:'open', unread_customer:0, unread_admin:0 }, messages };
}

async function listSupportConversations(env, url) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const result = await env.DB.prepare(`SELECT c.id, c.customer_browser_key, c.customer_number, c.status, c.unread_admin, c.unread_customer, c.created_at, c.updated_at, cu.name AS customer_name, cu.phone AS customer_phone,
    (SELECT message FROM support_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
    (SELECT sender_type FROM support_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender
    FROM support_conversations c LEFT JOIN customers cu ON cu.browser_key = c.customer_browser_key
    ORDER BY c.updated_at DESC LIMIT ?`).bind(limit).all();
  return result.results || [];
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

      // Public customer identity bootstrap. The browser key is anonymous and persistent on the customer device.
      if (path === "/api/customers/identify" && request.method === "POST") {
        let body; try { body = await request.json(); } catch { return json({ ok:false, error:"Invalid JSON" }, 400, request); }
        try {
          const customer = await identifyCustomer(env, request, body || {});
          return json({ ok:true, customer }, 200, request);
        } catch (error) {
          return json({ ok:false, error:error.message || String(error) }, 400, request);
        }
      }

      // Customer-owned booking list/status. It never exposes another customer's bookings.
      if (path === "/api/customer/bookings" && request.method === "GET") {
        const key = getCustomerKey(request, {});
        const customer = await getCustomerByKey(env, key);
        if (!customer) return json({ ok:false, error:"Customer not found" }, 404, request);
        const result = await env.DB.prepare(`SELECT id, customer_number, service, price, duration, booking_date, booking_time, inspiration, customer_note, status, created_at, updated_at FROM bookings WHERE customer_browser_key = ? ORDER BY created_at DESC LIMIT 50`).bind(key).all();
        return json({ ok:true, customerNumber: customer.customer_number, bookings: result.results || [] }, 200, request);
      }

      // Customer-owned notifications. The browser key is the anonymous customer identity.
      if (path === "/api/customer/notifications" && request.method === "GET") {
        const key = clean(request.headers.get("x-customer-key"), 120);
        if (!key) return json({ ok:false, error:"Customer identity required" }, 400, request);
        const customer = await getCustomerByKey(env, key);
        if (!customer) return json({ ok:false, error:"Customer not found" }, 404, request);
        const unreadOnly = request.url.includes("unread=1");
        const notifications = await listCustomerNotifications(env, key, unreadOnly);
        const unreadCount = (await listCustomerNotifications(env, key, true)).length;
        return json({ ok:true, customerNumber:customer.customer_number, notifications, unreadCount }, 200, request);
      }

      if (path === "/api/customer/notifications/read" && request.method === "POST") {
        const key = clean(request.headers.get("x-customer-key"), 120);
        if (!key) return json({ ok:false, error:"Customer identity required" }, 400, request);
        const customer = await getCustomerByKey(env, key);
        if (!customer) return json({ ok:false, error:"Customer not found" }, 404, request);
        let body = {};
        try { body = await request.json(); } catch {}
        const ids = Array.isArray(body?.ids) ? body.ids : [];
        await markCustomerNotificationsRead(env, key, ids);
        return json({ ok:true }, 200, request);
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


      // Customer support chat: one persistent conversation per customer browser identity.
      if (path === "/api/support/conversation" && request.method === "GET") {
        const key = clean(request.headers.get("x-customer-key"), 120);
        if (!key) return json({ok:false,error:"Customer identity required"},400,request);
        const data = await getSupportConversationForCustomer(env, key);
        if (!data) return json({ok:false,error:"Customer not found"},404,request);
        return json({ok:true,...data},200,request);
      }

      if (path === "/api/support/read" && request.method === "POST") {
        const key = clean(request.headers.get("x-customer-key"), 120);
        if (!key) return json({ok:false,error:"Customer identity required"},400,request);
        const customer = await getCustomerByKey(env, key);
        if (!customer) return json({ok:false,error:"Customer not found"},404,request);
        await env.DB.prepare(`UPDATE support_conversations SET unread_customer = 0 WHERE customer_browser_key = ?`).bind(key).run();
        return json({ok:true},200,request);
      }

      if (path === "/api/support/messages" && request.method === "POST") {
        const key = clean(request.headers.get("x-customer-key"), 120);
        if (!key) return json({ok:false,error:"Customer identity required"},400,request);
        const customer = await getCustomerByKey(env, key);
        if (!customer) return json({ok:false,error:"Customer not found"},404,request);
        const conversation = await ensureSupportConversation(env, customer);
        let body; try { body = await request.json(); } catch { return json({ok:false,error:"Invalid JSON"},400,request); }
        const message = await addSupportMessage(env, conversation, 'customer', body?.message, customer.name || `Customer ${customer.customer_number}`);
        return json({ok:true,message},201,request);
      }

      if (path === "/api/support/conversations" && request.method === "GET") {
        if (!env.ADMIN_TOKEN || request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) return json({ok:false,error:"Unauthorized"},401,request);
        return json({ok:true,conversations:await listSupportConversations(env,url)},200,request);
      }

      if (path.startsWith("/api/support/conversations/") && request.method === "GET") {
        if (!env.ADMIN_TOKEN || request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) return json({ok:false,error:"Unauthorized"},401,request);
        const id = Number(decodeURIComponent(path.slice("/api/support/conversations/".length)));
        if (!id) return json({ok:false,error:"Conversation id required"},400,request);
        const conversation = await env.DB.prepare(`SELECT c.*, cu.name AS customer_name, cu.phone AS customer_phone FROM support_conversations c LEFT JOIN customers cu ON cu.browser_key = c.customer_browser_key WHERE c.id = ?`).bind(id).first();
        if (!conversation) return json({ok:false,error:"Not found"},404,request);
        const messages = await listSupportMessages(env,id);
        await env.DB.prepare(`UPDATE support_conversations SET unread_admin = 0 WHERE id = ?`).bind(id).run();
        conversation.unread_admin = 0;
        return json({ok:true,conversation,messages},200,request);
      }

      if (path.startsWith("/api/support/conversations/") && path.endsWith("/messages") && request.method === "POST") {
        if (!env.ADMIN_TOKEN || request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) return json({ok:false,error:"Unauthorized"},401,request);
        const base = path.slice("/api/support/conversations/".length, -"/messages".length);
        const id = Number(decodeURIComponent(base.replace(/\/$/,"")));
        if (!id) return json({ok:false,error:"Conversation id required"},400,request);
        const conversation = await env.DB.prepare(`SELECT * FROM support_conversations WHERE id = ?`).bind(id).first();
        if (!conversation) return json({ok:false,error:"Not found"},404,request);
        let body; try { body = await request.json(); } catch { return json({ok:false,error:"Invalid JSON"},400,request); }
        const message = await addSupportMessage(env, conversation, 'admin', body?.message, 'Beauty Studio');
        return json({ok:true,message},201,request);
      }

      if (path.startsWith("/api/support/conversations/") && request.method === "PUT") {
        if (!env.ADMIN_TOKEN || request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) return json({ok:false,error:"Unauthorized"},401,request);
        const id = Number(decodeURIComponent(path.slice("/api/support/conversations/".length)));
        if (!id) return json({ok:false,error:"Conversation id required"},400,request);
        let body; try { body = await request.json(); } catch { return json({ok:false,error:"Invalid JSON"},400,request); }
        const status = clean(body?.status,30).toLowerCase();
        if (!['open','closed'].includes(status)) return json({ok:false,error:"Invalid conversation status"},400,request);
        const now = new Date().toISOString();
        await env.DB.prepare(`UPDATE support_conversations SET status = ?, updated_at = ? WHERE id = ?`).bind(status,now,id).run();
        const conversation = await env.DB.prepare(`SELECT * FROM support_conversations WHERE id = ?`).bind(id).first();
        return json({ok:true,conversation},200,request);
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
