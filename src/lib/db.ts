import Database from "better-sqlite3";
import { dirname } from "path";
import { mkdirSync } from "fs";
import { getSqlitePath } from "./config";
import type { StoredVideoTask, UpstreamVideoTask, UsageSummary, VideoStatus } from "./types";

type TaskRow = {
  id: number;
  user_hash: string;
  upstream_task_id: string;
  model: string | null;
  prompt: string | null;
  seconds: string | null;
  size: string | null;
  media_urls: string | null;
  cost_units: number | null;
  status: VideoStatus;
  progress: number | null;
  video_url: string | null;
  thumbnail_url: string | null;
  error_message: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

type UsageRow = {
  id: number;
  task_id: string | null;
  action: "create" | "retry";
  cost_units: number;
  created_at: string;
};

let db: Database.Database | null = null;

const ALLOWED_TABLES = new Set(["video_tasks", "usage_events"]);

function hasColumn(database: Database.Database, table: string, column: string) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`hasColumn: table "${table}" is not in the whitelist`);
  }
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function parseJsonArray(value: string | null) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function getDb() {
  if (db) {
    return db;
  }

  const sqlitePath = getSqlitePath();
  mkdirSync(dirname(sqlitePath), { recursive: true });
  db = new Database(sqlitePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_hash TEXT NOT NULL,
      upstream_task_id TEXT NOT NULL,
      model TEXT,
      prompt TEXT,
      seconds TEXT,
      size TEXT,
      media_urls TEXT NOT NULL DEFAULT '[]',
      cost_units INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      progress INTEGER,
      video_url TEXT,
      thumbnail_url TEXT,
      error_message TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      UNIQUE(user_hash, upstream_task_id)
    );

    CREATE INDEX IF NOT EXISTS idx_video_tasks_user_updated
      ON video_tasks(user_hash, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_video_tasks_expires
      ON video_tasks(expires_at);

    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_hash TEXT NOT NULL,
      task_id TEXT,
      action TEXT NOT NULL,
      cost_units INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_usage_events_user_created
      ON usage_events(user_hash, created_at DESC);
  `);

  if (!hasColumn(db, "video_tasks", "media_urls")) {
    db.prepare("ALTER TABLE video_tasks ADD COLUMN media_urls TEXT NOT NULL DEFAULT '[]'").run();
  }
  if (!hasColumn(db, "video_tasks", "cost_units")) {
    db.prepare("ALTER TABLE video_tasks ADD COLUMN cost_units INTEGER NOT NULL DEFAULT 0").run();
  }

  return db;
}

function mapTask(row: TaskRow): StoredVideoTask {
  return {
    id: row.id,
    upstreamTaskId: row.upstream_task_id,
    model: row.model,
    prompt: row.prompt,
    seconds: row.seconds,
    size: row.size,
    mediaUrls: parseJsonArray(row.media_urls),
    costUnits: row.cost_units || 0,
    status: row.status,
    progress: row.progress,
    videoUrl: row.video_url,
    thumbnailUrl: row.thumbnail_url,
    errorMessage: row.error_message,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}

export function pruneExpiredTasks() {
  const database = getDb();
  database.prepare("DELETE FROM video_tasks WHERE expires_at < datetime('now')").run();
  database.prepare("DELETE FROM usage_events WHERE created_at < datetime('now', '-30 days')").run();
}

function maybePrune() {
  if (Math.random() < 0.05) {
    pruneExpiredTasks();
  }
}

export function upsertVideoTask(
  userHash: string,
  task: UpstreamVideoTask,
  options: { mediaUrls?: string[]; costUnits?: number; prompt?: string; seconds?: string; size?: string; model?: string } = {}
) {
  maybePrune();

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const error = task.error;
  const hasMediaUrls = Boolean(options.mediaUrls);
  const mediaUrls = JSON.stringify(options.mediaUrls || []);
  const costUnits = options.costUnits ?? 0;

  getDb()
    .prepare(`
      INSERT INTO video_tasks (
        user_hash,
        upstream_task_id,
        model,
        prompt,
        seconds,
        size,
        media_urls,
        cost_units,
        status,
        progress,
        video_url,
        thumbnail_url,
        error_message,
        error_code,
        created_at,
        updated_at,
        expires_at
      )
      VALUES (
        @userHash,
        @upstreamTaskId,
        @model,
        @prompt,
        @seconds,
        @size,
        @mediaUrls,
        @costUnits,
        @status,
        @progress,
        @videoUrl,
        @thumbnailUrl,
        @errorMessage,
        @errorCode,
        @now,
        @now,
        @expiresAt
      )
      ON CONFLICT(user_hash, upstream_task_id) DO UPDATE SET
        model = COALESCE(excluded.model, video_tasks.model),
        prompt = COALESCE(excluded.prompt, video_tasks.prompt),
        seconds = COALESCE(excluded.seconds, video_tasks.seconds),
        size = COALESCE(excluded.size, video_tasks.size),
        media_urls = CASE
          WHEN @hasMediaUrls = 1 THEN excluded.media_urls
          ELSE video_tasks.media_urls
        END,
        cost_units = CASE
          WHEN excluded.cost_units > 0 THEN excluded.cost_units
          ELSE video_tasks.cost_units
        END,
        status = excluded.status,
        progress = excluded.progress,
        video_url = CASE
          WHEN excluded.video_url IS NOT NULL THEN excluded.video_url
          WHEN excluded.status = 'completed' THEN video_tasks.video_url
          ELSE NULL
        END,
        thumbnail_url = CASE
          WHEN excluded.thumbnail_url IS NOT NULL THEN excluded.thumbnail_url
          WHEN excluded.status = 'completed' THEN video_tasks.thumbnail_url
          ELSE NULL
        END,
        error_message = excluded.error_message,
        error_code = excluded.error_code,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `)
    .run({
      userHash,
      upstreamTaskId: task.id,
      model: options.model || task.model || null,
      prompt: options.prompt || task.prompt || null,
      seconds: options.seconds || (task.seconds == null ? null : String(task.seconds)),
      size: options.size || task.size || null,
      hasMediaUrls: hasMediaUrls ? 1 : 0,
      mediaUrls,
      costUnits,
      status: task.status,
      progress: task.progress ?? null,
      videoUrl: task.video_url || null,
      thumbnailUrl: task.thumbnail_url || null,
      errorMessage: error?.message || error?.reason || null,
      errorCode: error?.code || null,
      now,
      expiresAt
    });

  return getStoredTask(userHash, task.id);
}

export function recordUsageEvent(
  userHash: string,
  taskId: string | null,
  action: "create" | "retry",
  costUnits: number
) {
  maybePrune();
  getDb()
    .prepare(
      `INSERT INTO usage_events (user_hash, task_id, action, cost_units, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(userHash, taskId, action, Math.max(1, costUnits), new Date().toISOString());
}

export function getUsageSummary(userHash: string, limit = 12): UsageSummary {
  maybePrune();

  const total = getDb()
    .prepare("SELECT COALESCE(SUM(cost_units), 0) AS total FROM usage_events WHERE user_hash = ?")
    .get(userHash) as { total: number };
  const rows = getDb()
    .prepare(
      `SELECT id, task_id, action, cost_units, created_at
       FROM usage_events
       WHERE user_hash = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(userHash, Math.min(Math.max(limit, 1), 50)) as UsageRow[];

  return {
    totalCostUnits: total.total || 0,
    recentEvents: rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      action: row.action,
      costUnits: row.cost_units,
      createdAt: row.created_at
    }))
  };
}

export function listStoredTasks(userHash: string, limit = 30) {
  maybePrune();

  const rows = getDb()
    .prepare(
      `SELECT * FROM video_tasks
       WHERE user_hash = ?
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(userHash, Math.min(Math.max(limit, 1), 100)) as TaskRow[];

  return rows.map(mapTask);
}

export function getStoredTask(userHash: string, upstreamTaskId: string) {
  maybePrune();

  const row = getDb()
    .prepare("SELECT * FROM video_tasks WHERE user_hash = ? AND upstream_task_id = ?")
    .get(userHash, upstreamTaskId) as TaskRow | undefined;

  return row ? mapTask(row) : null;
}

export function getDatabaseHealth() {
  const row = getDb().prepare("SELECT 1 AS ok").get() as { ok: number };
  return { ok: row.ok === 1 };
}

export function markTaskAsFailed(userHash: string, upstreamTaskId: string, errorMessage: string) {
  return getDb()
    .prepare(`
      UPDATE video_tasks
      SET status = 'failed',
          error_message = ?,
          updated_at = datetime('now')
      WHERE user_hash = ? AND upstream_task_id = ?
    `)
    .run(errorMessage, userHash, upstreamTaskId);
}
