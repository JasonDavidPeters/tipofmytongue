/**
 * Tip of Your Tongue — server.js v3
 *
 * KEY CHANGE: Preview URLs are NEVER cached.
 * Deezer CDN URLs contain Akamai hdnea tokens that expire in ~30 minutes.
 * Caching them causes 403 errors. We do a fresh Deezer search every time
 * a round starts — the search API responds in ~200ms so this is imperceptible.
 *
 * Routes:
 *   GET /api/songs?era=all&genre=pop&count=10  → random songs from DB
 *   GET /api/preview?id=<n>                    → fresh Deezer preview URL (never cached)
 *   GET /api/stats                             → catalog counts by era + genre
 *   GET /api/health                            → uptime + DB check
 *   GET /api/admin/ingest?secret=X&force=true  → re-trigger catalog ingest
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

// ─── Instrumental keyword check (same list as catalog.js) ────────────────────
const INSTR_KW = [
  'instrumental', 'karaoke', 'backing track', 'backing version',
  'minus one', 'no vocal', 'no voice', 'music only',
  'piano version', 'orchestra version', 'orchestral',
  'in the style of', 'tribute instrumental',
];
function isInstrumental(t) {
  const v = (t.title_version || '').toLowerCase();
  const n = (t.title        || '').toLowerCase();
  return INSTR_KW.some(kw => v.includes(kw) || n.includes(kw));
}

// ─── GET /api/songs ───────────────────────────────────────────────────────────
// Supports filtering by era and/or genre. Returns id, title, artist so the
// frontend can request a fresh preview for each song as rounds begin.
app.get('/api/songs', async (req, res) => {
  const era   = req.query.era   || 'all';
  const genre = req.query.genre || 'all';
  const count = Math.min(parseInt(req.query.count) || 10, 50);

  try {
    const conditions = ['enabled = true'];
    const params     = [];

    if (era   !== 'all') { params.push(era);   conditions.push(`era = $${params.length}`); }
    if (genre !== 'all') { params.push(genre);  conditions.push(`genre = $${params.length}`); }

    params.push(count);
    const where = conditions.join(' AND ');
    const sql   = `SELECT id, title, artist, era, genre, decade
                   FROM songs WHERE ${where}
                   ORDER BY RANDOM() LIMIT $${params.length}`;

    let result = await pool.query(sql, params);

    // Fallback: if filtered query returns nothing, pull from full catalog
    if (result.rows.length === 0) {
      result = await pool.query(
        `SELECT id, title, artist, era, genre, decade
         FROM songs WHERE enabled = true
         ORDER BY RANDOM() LIMIT $1`,
        [count]
      );
    }

    res.json({ songs: result.rows });
  } catch (err) {
    console.error('[/api/songs]', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── GET /api/preview?id=<songId> ────────────────────────────────────────────
// ALWAYS fetches a fresh URL from Deezer. No caching of any kind.
// Deezer CDN tokens expire in ~30 minutes — any cache will cause 403 errors.
app.get('/api/preview', async (req, res) => {
  const songId = parseInt(req.query.id);
  if (!songId) return res.status(400).json({ error: 'Missing param: id' });

  // Fetch song metadata from DB (just title/artist/query — NOT a cached URL)
  let song;
  try {
    const { rows } = await pool.query(
      'SELECT id, title, artist, deezer_query FROM songs WHERE id = $1',
      [songId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Song not found' });
    song = rows[0];
  } catch (err) {
    console.error('[/api/preview] DB:', err.message);
    return res.status(500).json({ error: 'Database error' });
  }

  // Fresh Deezer search — try progressively broader queries
  const queries = [
    song.deezer_query,                                              // most specific
    `"${song.title}" "${song.artist}" karaoke`,
    `"${song.title}" karaoke instrumental`,
    `${song.title} ${song.artist} karaoke`,                        // broadest fallback
  ];

  let previewUrl = null;

  for (const q of queries) {
    if (previewUrl) break;
    try {
      const r    = await fetch(
        `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=25`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (!r.ok) continue;
      const data = await r.json();
      for (const t of (data.data || [])) {
        if (t.preview && isInstrumental(t)) {
          previewUrl = t.preview;
          break;
        }
      }
    } catch (e) {
      console.warn('[/api/preview] Deezer search failed:', e.message);
    }
  }

  res.json({ previewUrl: previewUrl ?? null });
});

// ─── GET /api/stats ───────────────────────────────────────────────────────────
app.get('/api/stats', async (_req, res) => {
  try {
    const byEra = await pool.query(
      `SELECT era, COUNT(*) AS count FROM songs WHERE enabled=true GROUP BY era ORDER BY era`
    );
    const byGenre = await pool.query(
      `SELECT genre, COUNT(*) AS count FROM songs WHERE enabled=true AND genre IS NOT NULL GROUP BY genre ORDER BY count DESC`
    );
    const total = byEra.rows.reduce((s, r) => s + parseInt(r.count), 0);
    res.json({ total, byEra: byEra.rows, byGenre: byGenre.rows });
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

// ─── Testing mode flag ────────────────────────────────────────────────────────
// Set TESTING=true in Render environment variables to enable alpha-test mode.
// In testing mode:
//   • The songs table is wiped on every server restart
//   • GET /api/admin/reset clears the table and re-seeds (no secret required)
//   • GET /api/config tells the frontend that testing mode is active
const TESTING = process.env.TESTING === 'true';

// ─── GET /api/config ──────────────────────────────────────────────────────────
// Frontend reads this on load to know whether to show the reset button / banner.
app.get('/api/config', (_req, res) => {
  res.json({ testing: TESTING });
});

// ─── GET /api/admin/ingest ────────────────────────────────────────────────────
app.get('/api/admin/ingest', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!TESTING && secret && req.query.secret !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({ message: 'Ingest started', force: req.query.force === 'true' });
  ingestFromDeezer({ force: req.query.force === 'true' }).catch(console.error);
});

// ─── GET /api/admin/reset ─────────────────────────────────────────────────────
// Testing-mode only. Truncates the songs table then re-runs the full ingest.
// Returns 403 in production.
app.get('/api/admin/reset', async (_req, res) => {
  if (!TESTING) return res.status(403).json({ error: 'Not in testing mode' });
  try {
    await pool.query('TRUNCATE TABLE songs RESTART IDENTITY');
    console.log('[TESTING] Songs table cleared');
    res.json({ message: 'Table cleared — re-seeding in background' });
    ingestFromDeezer({ force: true }).catch(console.error);
  } catch (err) {
    console.error('[TESTING] Reset failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  try {
    await ensureSchema();
    console.log('DB schema ready');
  } catch (err) {
    console.error('Fatal — schema error:', err.message);
    process.exit(1);
  }

  if (TESTING) {
    console.log('WARNING: TESTING MODE — clearing songs table on startup');
    await pool.query('TRUNCATE TABLE songs RESTART IDENTITY').catch(console.error);
  }

  app.listen(PORT, () => {
    console.log('TOYT running on http://localhost:' + PORT + ' [testing=' + TESTING + ']');
  });

  ingestFromDeezer({ force: TESTING }).catch(console.error);
}

start();
