CREATE TABLE IF NOT EXISTS studio_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gallery (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS booking_rules (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  service TEXT NOT NULL,
  price TEXT,
  duration TEXT,
  booking_date TEXT NOT NULL,
  booking_time TEXT NOT NULL,
  inspiration TEXT,
  customer_note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookings_date_time ON bookings(booking_date, booking_time);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);


CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_browser_key TEXT NOT NULL,
  customer_number TEXT,
  booking_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_customer ON notifications(customer_browser_key, is_read, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_booking ON notifications(booking_id);


CREATE TABLE IF NOT EXISTS support_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_browser_key TEXT NOT NULL UNIQUE,
  customer_number TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  unread_customer INTEGER NOT NULL DEFAULT 0,
  unread_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_support_conversations_updated ON support_conversations(updated_at);
CREATE INDEX IF NOT EXISTS idx_support_conversations_unread_admin ON support_conversations(unread_admin, updated_at);

CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  sender_type TEXT NOT NULL,
  sender_name TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES support_conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_support_messages_conversation ON support_messages(conversation_id, id);
