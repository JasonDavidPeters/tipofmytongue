/**
 * Tip of Your Tongue — server.js v2
 *
 * Routes:
 *   GET /api/songs?era=all&count=10     → random songs from PostgreSQL
 *   GET /api/preview?id=<song_id>       → Deezer karaoke/instrumental preview URL
 *   GET /api/health                     → uptime check
 */

require('dotenv').config();
const express = require('express');
const path    = require('path');
const pool    = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-process preview cache (warm Render instance reuse) ────────────────────
// Key: song_id → { previewUrl, cachedAt }
// This is L1 cache. The DB `preview_cache` column acts as persistent L2.
const previewMemCache = new Map();
const CACHE_TTL_MS    = 60 * 60 * 1000; // 1 hour

// ─── GET /api/songs ───────────────────────────────────────────────────────────
// Returns `count` random enabled songs, optionally filtered by era.
// The DB does the randomisation — no JS array needed.
app.get('/api/songs', async (req, res) => {
  const era   = req.query.era   || 'all';
  const count = Math.min(parseInt(req.query.count) || 10, 50); // cap at 50

  try {
    let query, params;

    if (era === 'all') {
      query  = `SELECT id, title, artist, era, decade
                FROM songs
                WHERE enabled = true
                ORDER BY RANDOM()
                LIMIT $1`;
      params = [count];
    } else {
      query  = `SELECT id, title, artist, era, decade
                FROM songs
                WHERE enabled = true AND era = $1
                ORDER BY RANDOM()
                LIMIT $2`;
      params = [era, count];
    }

    const { rows } = await pool.query(query, params);

    if (rows.length === 0) {
      // Era filter returned nothing — fall back to all eras
      const fallback = await pool.query(
        `SELECT id, title, artist, era, decade FROM songs WHERE enabled = true ORDER BY RANDOM() LIMIT $1`,
        [count]
      );
      return res.json({ songs: fallback.rows, fallback: true });
    }

    res.json({ songs: rows });
  } catch (err) {
    console.error('[/api/songs]', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── GET /api/preview?id=<song_id> ───────────────────────────────────────────
// Returns a Deezer karaoke/instrumental preview URL for the given song.
// Search strategy: try "karaoke" first, then "instrumental", then bare title.
// Caches in memory + DB to avoid hammering Deezer.
app.get('/api/preview', async (req, res) => {
  const songId = parseInt(req.query.id);
  if (!songId) return res.status(400).json({ error: 'Missing param: id' });

  // ── L1: memory cache ────────────────────────────────────────────────────────
  const mem = previewMemCache.get(songId);
  if (mem && Date.now() - mem.cachedAt < CACHE_TTL_MS) {
    return res.json({ previewUrl: mem.previewUrl });
  }

  // ── Fetch song from DB ───────────────────────────────────────────────────────
  let song;
  try {
    const { rows } = await pool.query(
      'SELECT id, title, artist, deezer_query, preview_cache, preview_cached_at FROM songs WHERE id = $1',
      [songId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Song not found' });
    song = rows[0];
  } catch (err) {
    console.error('[/api/preview] DB fetch:', err.message);
    return res.status(500).json({ error: 'Database error' });
  }

  // ── L2: DB cache (valid for 24 hours) ───────────────────────────────────────
  if (song.preview_cache && song.preview_cached_at) {
    const ageMs = Date.now() - new Date(song.preview_cached_at).getTime();
    if (ageMs < 24 * 60 * 60 * 1000) {
      previewMemCache.set(songId, { previewUrl: song.preview_cache, cachedAt: Date.now() });
      return res.json({ previewUrl: song.preview_cache });
    }
  }

  // ── Deezer search ────────────────────────────────────────────────────────────
  // We try up to 3 queries in order of preference:
  //   1. The song's custom deezer_query (stored in DB, includes "karaoke"/"instrumental")
  //   2. Generic karaoke search
  //   3. Bare artist + title (last resort — may return the vocal version)
  const searchQueries = [
    song.deezer_query,
    `artist:"${song.artist}" track:"${song.title}" karaoke`,
    `"${song.title}" "${song.artist}" instrumental`,
  ];

  let previewUrl = null;

  for (const q of searchQueries) {
    if (previewUrl) break;
    try {
      const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=15`;
      const r   = await fetch(url);
      if (!r.ok) continue;
      const data = await r.json();
      for (const track of (data.data || [])) {
        if (track.preview) {
          previewUrl = track.preview;
          break;
        }
      }
    } catch (e) {
      console.warn(`Deezer search failed for query "${q}":`, e.message);
    }
  }

  // ── Persist to DB cache ──────────────────────────────────────────────────────
  if (previewUrl) {
    previewMemCache.set(songId, { previewUrl, cachedAt: Date.now() });
    pool.query(
      'UPDATE songs SET preview_cache = $1, preview_cached_at = NOW() WHERE id = $2',
      [previewUrl, songId]
    ).catch(e => console.warn('Cache write failed:', e.message));
  }

  res.json({ previewUrl: previewUrl ?? null });
});

// ─── GET /api/stats ───────────────────────────────────────────────────────────
app.get('/api/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT era, COUNT(*) as count
      FROM songs WHERE enabled = true
      GROUP BY era ORDER BY era
    `);
    const total = rows.reduce((s, r) => s + parseInt(r.count), 0);
    res.json({ total, byEra: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/health ─────────────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

// ─── SPA catch-all ───────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🎵 Tip of Your Tongue v2 on http://localhost:${PORT}`);
  console.log(`   Songs served from: PostgreSQL`);
  console.log(`   Audio source:      Deezer karaoke/instrumental search`);
});
