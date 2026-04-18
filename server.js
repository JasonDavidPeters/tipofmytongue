/**
 * Tip of Your Tongue — server.js v2.1
 *
 * On startup:
 *   1. Ensures the DB schema exists
 *   2. If the songs table has fewer than 100 rows, triggers a full Deezer ingest
 *   3. Starts serving the game immediately — ingest runs in the background
 *
 * Routes:
 *   GET /api/songs?era=all&count=10    → random songs from DB
 *   GET /api/preview?id=<n>            → Deezer karaoke preview URL (cached)
 *   GET /api/stats                     → catalog size by era
 *   GET /api/health                    → uptime + DB check
 *   GET /api/admin/ingest              → manually trigger re-ingest (needs ADMIN_SECRET)
 */

require('dotenv').config();
const express = require('express');
const path    = require('path');
const pool    = require('./db');
const { ingestFromDeezer, ensureSchema } = require('./catalog');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory L1 preview cache ───────────────────────────────────────────────
const previewCache = new Map(); // songId → { url, cachedAt }
const CACHE_TTL    = 60 * 60 * 1000; // 1 hour

// ─── GET /api/songs ───────────────────────────────────────────────────────────
app.get('/api/songs', async (req, res) => {
  const era   = req.query.era || 'all';
  const count = Math.min(parseInt(req.query.count) || 10, 50);

  try {
    let result;
    if (era === 'all') {
      result = await pool.query(
        `SELECT id, title, artist, era, decade
         FROM songs WHERE enabled = true
         ORDER BY RANDOM() LIMIT $1`,
        [count]
      );
    } else {
      result = await pool.query(
        `SELECT id, title, artist, era, decade
         FROM songs WHERE enabled = true AND era = $1
         ORDER BY RANDOM() LIMIT $2`,
        [era, count]
      );
      // Fallback to all eras if this one has too few songs
      if (result.rows.length < count) {
        result = await pool.query(
          `SELECT id, title, artist, era, decade
           FROM songs WHERE enabled = true
           ORDER BY RANDOM() LIMIT $1`,
          [count]
        );
      }
    }

    res.json({ songs: result.rows });
  } catch (err) {
    console.error('[/api/songs]', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── GET /api/preview?id=<songId> ────────────────────────────────────────────
app.get('/api/preview', async (req, res) => {
  const songId = parseInt(req.query.id);
  if (!songId) return res.status(400).json({ error: 'Missing param: id' });

  // L1: memory
  const mem = previewCache.get(songId);
  if (mem && Date.now() - mem.cachedAt < CACHE_TTL) {
    return res.json({ previewUrl: mem.url });
  }

  // Fetch song record
  let song;
  try {
    const { rows } = await pool.query(
      `SELECT id, title, artist, deezer_query, preview_cache, preview_cached_at
       FROM songs WHERE id = $1`,
      [songId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Song not found' });
    song = rows[0];
  } catch (err) {
    return res.status(500).json({ error: 'Database error' });
  }

  // L2: DB cache (valid 24 h)
  if (song.preview_cache && song.preview_cached_at) {
    const age = Date.now() - new Date(song.preview_cached_at).getTime();
    if (age < 24 * 60 * 60 * 1000) {
      previewCache.set(songId, { url: song.preview_cache, cachedAt: Date.now() });
      return res.json({ previewUrl: song.preview_cache });
    }
  }

  // L3: live Deezer search — try karaoke, then instrumental, then bare
  const queries = [
    song.deezer_query,
    `artist:"${song.artist}" track:"${song.title}" instrumental`,
    `"${song.title}" "${song.artist}"`,
  ];

  let previewUrl = null;
  for (const q of queries) {
    if (previewUrl) break;
    try {
      const r    = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=15`);
      const data = await r.json();
      for (const t of (data.data || [])) {
        if (t.preview) { previewUrl = t.preview; break; }
      }
    } catch (e) {
      console.warn('Deezer search error:', e.message);
    }
  }

  if (previewUrl) {
    previewCache.set(songId, { url: previewUrl, cachedAt: Date.now() });
    pool.query(
      `UPDATE songs SET preview_cache=$1, preview_cached_at=NOW() WHERE id=$2`,
      [previewUrl, songId]
    ).catch(() => {});
  }

  res.json({ previewUrl: previewUrl ?? null });
});

// ─── GET /api/stats ───────────────────────────────────────────────────────────
app.get('/api/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT era, COUNT(*) AS count
      FROM songs WHERE enabled = true
      GROUP BY era ORDER BY era
    `);
    const total = rows.reduce((s, r) => s + parseInt(r.count), 0);
    res.json({ total, byEra: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/health ──────────────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*) AS n FROM songs WHERE enabled=true');
    res.json({ status: 'ok', songs: parseInt(rows[0].n), ts: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'db_error' });
  }
});

// ─── GET /api/admin/ingest ────────────────────────────────────────────────────
// Manually re-trigger ingest. Protect with ADMIN_SECRET env var.
// Call: GET /api/admin/ingest?secret=<ADMIN_SECRET>&force=true
app.get('/api/admin/ingest', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const force = req.query.force === 'true';

  res.json({ message: 'Ingest started in background', force });

  // Run async — don't block the response
  ingestFromDeezer({ force }).catch(err =>
    console.error('Manual ingest error:', err.message)
  );
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  // Step 1: ensure schema is ready before accepting any traffic
  try {
    await ensureSchema();
    console.log('✓ DB schema ready');
  } catch (err) {
    console.error('Fatal: could not create schema:', err.message);
    process.exit(1);
  }

  // Step 2: start the HTTP server immediately so Render's health check passes
  app.listen(PORT, () => {
    console.log(`🎵 TOYT running on http://localhost:${PORT}`);
  });

  // Step 3: kick off catalog ingest in the background
  // If the DB already has songs this returns immediately, no cost.
  ingestFromDeezer().catch(err =>
    console.error('Background ingest error:', err.message)
  );
}

start();
