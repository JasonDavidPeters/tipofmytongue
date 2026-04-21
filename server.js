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
const { registerAuthRoutes, ensureUserSchema, requireDev } = require('./auth');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
registerAuthRoutes(app); // Auth routes + cookie/JWT middleware

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
  const era    = req.query.era    || 'all';
  const genre  = req.query.genre  || 'all';
  const artist = req.query.artist || 'all';
  const count  = Math.min(parseInt(req.query.count) || 10, 50);

  try {
    const conditions = ['enabled = true'];
    const params     = [];

    if (artist !== 'all') {
      // Artist mode: exact match on the artist column (no LIKE wildcards).
      // The DB artist column holds the real artist name stored at ingest time.
      // We compare normalised (lower, strip punctuation) to handle minor variations.
      params.push(artist.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim());
      conditions.push(
        `regexp_replace(lower(artist), '[^a-z0-9 ]', ' ', 'g') = $${params.length}`
      );
    } else {
      if (era   !== 'all') { params.push(era);   conditions.push(`era = $${params.length}`); }
      if (genre !== 'all') { params.push(genre);  conditions.push(`genre = $${params.length}`); }
    }

    // Count total available before applying LIMIT — frontend uses this to
    // cap the number of rounds when the artist catalog is smaller than requested.
    const countWhere = conditions.join(' AND ');
    const countParams = [...params];
    const totalAvailable = await pool.query(
      `SELECT COUNT(*) AS n FROM songs WHERE ${countWhere}`,
      countParams
    );
    const available = parseInt(totalAvailable.rows[0].n);

    params.push(Math.min(count, available || count));
    const where = countWhere;
    const sql   = `SELECT id, title, artist, era, genre, decade, deezer_query
                   FROM songs WHERE ${where}
                   ORDER BY RANDOM() LIMIT $${params.length}`;

    let result = await pool.query(sql, params);

    // Only fall back to full catalog for genre/era mode, never for artist mode
    if (result.rows.length === 0 && artist === 'all') {
      result = await pool.query(
        `SELECT id, title, artist, era, genre, decade, deezer_query
         FROM songs WHERE enabled = true
         ORDER BY RANDOM() LIMIT $1`,
        [count]
      );
    }

    res.json({ songs: result.rows, totalAvailable: available });
  } catch (err) {
    console.error('[/api/songs]', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── POST /api/game-start ─────────────────────────────────────────────────────
// Selects songs AND resolves all Deezer preview URLs server-side.
// Returns {songs: [{id,title,artist,era,genre,decade,previewUrl}]}
// Preview URLs never appear in client HTML source — only received at game time.
app.post('/api/game-start', async (req, res) => {
  const { count = 10, era = 'all', genre = 'all', artist = 'all' } = req.body || {};

  // ── Step 1: Select songs (same logic as /api/songs) ──────────────────────
  const conditions = ['enabled = true'];
  const params = [];

  if (artist !== 'all') {
    params.push(artist.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim());
    conditions.push(`regexp_replace(lower(artist), '[^a-z0-9 ]', ' ', 'g') = $${params.length}`);
  } else {
    if (era   !== 'all') { params.push(era);   conditions.push(`era = $${params.length}`); }
    if (genre !== 'all') { params.push(genre); conditions.push(`genre = $${params.length}`); }
  }

  const where = conditions.join(' AND ');
  // Fetch 3x the requested count so we have spares after preview filtering
  const fetchCount = Math.min(parseInt(count) * 3, 300);
  params.push(fetchCount);

  let candidates;
  try {
    const result = await pool.query(
      `SELECT id, title, artist, era, genre, decade, deezer_query
       FROM songs WHERE ${where} ORDER BY RANDOM() LIMIT $${params.length}`,
      params
    );
    candidates = result.rows;
    if (!candidates.length) {
      return res.status(404).json({ error: 'No songs found for these filters' });
    }
  } catch (err) {
    console.error('[/api/game-start] DB:', err.message);
    return res.status(500).json({ error: 'Database error' });
  }

  // ── Step 2: Deduplicate by normalised title ───────────────────────────────
  const seenTitles = new Set();
  candidates = candidates.filter(s => {
    const norm = s.title.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    if (seenTitles.has(norm)) return false;
    seenTitles.add(norm);
    return true;
  });

  // ── Step 3: Resolve preview URLs in parallel (capped concurrency) ─────────
  const needed = parseInt(count);
  const resolvedSongs = [];

  // Process in batches of 5 to avoid hammering Deezer
  for (let i = 0; i < candidates.length && resolvedSongs.length < needed; i += 5) {
    const batch = candidates.slice(i, i + 5);
    const results = await Promise.all(batch.map(async song => {
      const queries = [
        song.deezer_query,
        `${song.title} "${song.artist}" karaoke`,
        `${song.title} "${song.artist}" instrumental`,
        `"${song.artist}" ${song.title} karaoke instrumental`,
        `${song.title} karaoke instrumental`,
        `${song.title} karaoke`,
      ];
      for (const q of queries) {
        try {
          const r = await fetch(
            `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=50`,
            { signal: AbortSignal.timeout(8000) }
          );
          if (!r.ok) continue;
          const data = await r.json();
          for (const t of (data.data || [])) {
            if (t.preview && isInstrumental(t)) {
              // t.link is the karaoke track page — we build a search URL for the
              // original song instead so users find the real recording
              const deezerLink = `https://www.deezer.com/search/${encodeURIComponent(song.title + ' ' + song.artist)}`;
              return { ...song, previewUrl: t.preview, deezerLink };
            }
          }
        } catch (e) { /* try next query */ }
      }
      console.warn(`[game-start] No preview: ${song.title} — ${song.artist}`);
      return null; // no preview found
    }));

    for (const s of results) {
      if (s && resolvedSongs.length < needed) resolvedSongs.push(s);
    }
  }

  if (!resolvedSongs.length) {
    return res.status(503).json({ error: 'Could not find any playable songs — try again' });
  }

  // Strip deezer_query before sending to client (internal field)
  const clientSongs = resolvedSongs.map(({ deezer_query, ...rest }) => rest);
  res.json({ songs: clientSongs, total: clientSongs.length });
});

// ─── GET /api/preview?id=<songId> ─────────────────────────────────────────────
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

  // Fresh Deezer search — try progressively broader queries.
  // Karaoke track titles on Deezer include publisher suffixes like
  // "(By Coldplay) (Instrumental Karaoke Version)" so we DON'T quote the title.
  // We anchor by artist name (quoted) and add karaoke/instrumental keywords.
  const queries = [
    song.deezer_query,                                                        // stored query from ingest
    `${song.title} "${song.artist}" karaoke`,                                 // unquoted title, quoted artist
    `${song.title} "${song.artist}" instrumental`,
    `"${song.artist}" ${song.title} karaoke instrumental`,                    // artist first
    `${song.title} karaoke instrumental`,                                     // drop artist entirely
    `${song.title} karaoke`,                                                  // broadest
  ];

  let previewUrl = null;

  for (const q of queries) {
    if (previewUrl) break;
    try {
      const r = await fetch(
        `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=50`,
        { signal: AbortSignal.timeout(10000) }
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

  // If still nothing, mark this song as having no preview so the game
  // can skip it cleanly. We log it so we can identify problem songs.
  if (!previewUrl) {
    console.warn(`[/api/preview] No instrumental preview found for: ${song.title} — ${song.artist}`);
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

// ─── GET /api/admin/debug-ingest ──────────────────────────────────────────────
// Runs the full ingest pipeline for ONE Deezer search query and returns a
// detailed breakdown of every track — what Deezer returned and exactly which
// filter rejected it. Used to diagnose why artists get too few songs.
// Call: GET /api/admin/debug-ingest?q=Coldplay+karaoke+instrumental
app.get('/api/admin/debug-ingest', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Need ?q= param' });

  // Inline the same filters used in catalog.js
  const INSTRUMENTAL_KEYWORDS = [
    'instrumental','karaoke','backing track','backing version',
    'minus one','no vocal','no voice','music only',
    'piano version','orchestra version','orchestral version',
    'acoustic instrumental','in the style of','tribute instrumental',
  ];
  const REJECT_PATTERNS = [
    /\bmedley\b/i,/\bmegamix\b/i,/\bmashup\b/i,/\bmash.?up\b/i,
    /\bcollection\b/i,/\bcompilation\b/i,/\d+\s+(hits|songs|classics)\s+in\s+\d+/i,
    /\bnon.?stop\b/i,/\bparty\s+mix\b/i,/\bkaraoke\s+megamix\b/i,
  ];

  const TITLE_STRIP = [
    /\s*\(originally performed by[^)]*\)/gi,
    /\s*\(originally recorded by[^)]*\)/gi,
    /\s*\(in the style of[^)]*\)/gi,
    /\s*\(karaoke[^)]*\)/gi,
    /\s*\(instrumental[^)]*\)/gi,
    /\s*\(backing track[^)]*\)/gi,
    /\s*\[karaoke[^\]]*\]/gi,
    /\s*\[instrumental[^\]]*\]/gi,
    /\s*[-\u2013]\s*(karaoke|instrumental|backing track)[^\n]*/gi,
  ];
  const ARTIST_PATTERNS = [
    /originally performed by\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
    /originally recorded by\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
    /in the style of\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
    /made famous by\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
    /as performed by\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
  ];

  function cleanTitle(raw) {
    let s = raw || '';
    for (const p of TITLE_STRIP) s = s.replace(p, '');
    return s.trim();
  }
  function extractTitle(track) {
    const sc = cleanTitle(track.title_short || '');
    return sc.length > 1 ? sc : cleanTitle(track.title || '');
  }
  function extractArtist(track) {
    for (const p of ARTIST_PATTERNS) {
      const m = (track.title || '').match(p);
      if (m) return m[1].replace(/\s*[-\u2013]\s*(karaoke|instrumental).*/i,'').trim();
    }
    return null;
  }

  try {
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=100`;
    const r   = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const d   = await r.json();
    const raw = d.data || [];

    const results = raw.map(t => {
      const title      = extractTitle(t);
      const artist     = extractArtist(t);
      const titleLower = (t.title || '').toLowerCase();
      const versionLow = (t.title_version || '').toLowerCase();

      const isInstr    = INSTRUMENTAL_KEYWORDS.some(kw => titleLower.includes(kw) || versionLow.includes(kw));
      const hasPreview = !!t.preview;
      const goodDur    = t.duration >= 60 && t.duration <= 600;
      const notReject  = !REJECT_PATTERNS.some(p => p.test(t.title || ''));

      let rejection = null;
      if (!hasPreview)  rejection = 'no_preview';
      else if (!isInstr) rejection = 'not_instrumental';
      else if (!goodDur) rejection = `bad_duration_${t.duration}s`;
      else if (!notReject) rejection = 'rejected_title_pattern';

      return {
        passes:       !rejection,
        rejection,
        deezer_title:  t.title,
        deezer_version:t.title_version || '',
        deezer_artist: t.artist?.name || '',
        extracted_title: title,
        extracted_artist: artist,
        duration:      t.duration,
        preview:       hasPreview,
        album:         t.album?.title || '',
        release_date:  t.album?.release_date || '',
      };
    });

    const passing  = results.filter(r => r.passes);
    const rejected = results.filter(r => !r.passes);

    // Tally rejection reasons
    const reasons = {};
    rejected.forEach(r => { reasons[r.rejection] = (reasons[r.rejection] || 0) + 1; });

    res.json({
      query,
      total_returned: raw.length,
      passing:        passing.length,
      rejected:       rejected.length,
      rejection_breakdown: reasons,
      passing_tracks: passing,
      rejected_sample: rejected.slice(0, 20),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Removes songs from the DB that are clearly wrong:
//   1. Songs stored under a locked artist but whose year falls outside that
//      artist's known decade window (e.g. Balada para Adelina under Adele)
//   2. Songs with decade=null stored under a locked artist (unverifiable)
// Safe to run at any time — only deletes, does not modify other songs.
// Call: GET /api/admin/clean?secret=X  (add &dry_run=true to preview)
app.get('/api/admin/clean', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  const hasDev = req.user && (req.user.role === 'developer' || req.user.role === 'admin');
  if (!TESTING && !hasDev && secret && req.query.secret !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const dryRun = req.query.dry_run === 'true';

  // Artist decade windows — must match catalog.js source definitions
  const ARTIST_WINDOWS = {
    'adele':            { min: 2008, max: 2029 },
    'taylor swift':     { min: 2006, max: 2029 },
    'ed sheeran':       { min: 2011, max: 2029 },
    'billie eilish':    { min: 2016, max: 2029 },
    'dua lipa':         { min: 2015, max: 2029 },
    'ariana grande':    { min: 2013, max: 2029 },
    'olivia rodrigo':   { min: 2021, max: 2029 },
    'harry styles':     { min: 2017, max: 2029 },
    'justin bieber':    { min: 2009, max: 2029 },
    'bruno mars':       { min: 2010, max: 2029 },
    'the weeknd':       { min: 2012, max: 2029 },
    'sza':              { min: 2017, max: 2029 },
    'lady gaga':        { min: 2008, max: 2016 },
    'beyonce':          { min: 2003, max: 2029 },
    'rihanna':          { min: 2005, max: 2016 },
    'drake':            { min: 2009, max: 2029 },
    'kendrick lamar':   { min: 2011, max: 2029 },
    'post malone':      { min: 2016, max: 2029 },
    'shania twain':     { min: 1993, max: 2003 },
    'dolly parton':     { min: 1967, max: 1990 },
    'johnny cash':      { min: 1955, max: 1985 },
    'garth brooks':     { min: 1989, max: 2001 },
    'morgan wallen':    { min: 2018, max: 2029 },
    'luke bryan':       { min: 2007, max: 2029 },
    'nirvana':          { min: 1989, max: 1999 },
    'queen':            { min: 1973, max: 1991 },
    'beatles':          { min: 1963, max: 1970 },
    'eminem':           { min: 1999, max: 2020 },
    'coldplay':         { min: 2000, max: 2022 },
    'abba':             { min: 1972, max: 1982 },
    'elton john':       { min: 1970, max: 1990 },
    'whitney houston':  { min: 1985, max: 2009 },
    'mariah carey':     { min: 1990, max: 2005 },
  };

  try {
    const { rows: allSongs } = await pool.query(
      `SELECT id, title, artist, decade FROM songs WHERE enabled = true ORDER BY artist, title`
    );

    const toDelete = [];
    for (const song of allSongs) {
      const artistKey = song.artist.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      const window = ARTIST_WINDOWS[artistKey];
      if (!window) continue; // not a locked artist, skip

      if (song.decade === null) {
        toDelete.push({ ...song, reason: 'null decade on locked artist' });
      } else if (song.decade < window.min || song.decade > window.max) {
        toDelete.push({ ...song, reason: `decade ${song.decade} outside ${window.min}-${window.max}` });
      }
    }

    if (!dryRun && toDelete.length > 0) {
      const ids = toDelete.map(s => s.id);
      await pool.query(`DELETE FROM songs WHERE id = ANY($1)`, [ids]);
    }

    res.json({
      dry_run: dryRun,
      removed: toDelete.length,
      songs: toDelete.map(s => ({ id: s.id, title: s.title, artist: s.artist, decade: s.decade, reason: s.reason })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Backfills decade=null rows using the Deezer cross-reference year lookup.
// Runs in the background — responds immediately with "started".
// Call: GET /api/admin/fix-years?secret=X
// Optional: ?artist=Adele to only fix one artist's songs.
app.get('/api/admin/fix-years', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  const hasDev = req.user && (req.user.role === 'developer' || req.user.role === 'admin');
  if (!TESTING && !hasDev && secret && req.query.secret !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const artistFilter = req.query.artist || null;
  res.json({ message: 'Year fix started in background', artist: artistFilter || 'all' });

  // Run async
  (async () => {
    try {
      // Inline the karaoke-filtering logic here since we can't import from catalog.js easily
      const KARAOKE_ALBUM_KW = [
        'karaoke','instrumental','backing track','tribute','in the style',
        'made famous','originally performed','cover','sing along','minus one',
      ];
      function isKaraokeTrack(t) {
        const tt = (t.title || '').toLowerCase();
        const at = (t.album && t.album.title ? t.album.title : '').toLowerCase();
        const ar = (t.artist && t.artist.name ? t.artist.name : '').toLowerCase();
        if (KARAOKE_ALBUM_KW.some(kw => tt.includes(kw))) return true;
        if (KARAOKE_ALBUM_KW.some(kw => at.includes(kw))) return true;
        if (['karaoke','tribute','hits factory','sing'].some(kw => ar.includes(kw))) return true;
        return false;
      }

      async function getDeezerYear(title, artist) {
        const queries = [
          `artist:"${artist}" track:"${title}"`,
          `${title} ${artist}`,
        ];
        let bestYear = null;
        for (const q of queries) {
          if (bestYear !== null) break;
          try {
            const r = await fetch(
              `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=20`,
              { signal: AbortSignal.timeout(8000) }
            );
            if (!r.ok) continue;
            const d = await r.json();
            for (const t of (d.data || [])) {
              if (isKaraokeTrack(t)) continue;
              const y = parseInt((t.album && t.album.release_date ? t.album.release_date : '').slice(0, 4));
              if (!isNaN(y) && y >= 1920 && y <= 2030) {
                if (bestYear === null || y < bestYear) bestYear = y;
              }
            }
          } catch (e) { /* try next */ }
          await new Promise(r => setTimeout(r, 150));
        }
        return bestYear;
      }

      // Fetch all songs with null decade
      let sql = 'SELECT id, title, artist FROM songs WHERE decade IS NULL AND enabled = true';
      const params = [];
      if (artistFilter) { params.push(artistFilter); sql += ' AND lower(artist) = lower($1)'; }
      sql += ' ORDER BY artist, title';

      const { rows } = await pool.query(sql, params);
      console.log(`[fix-years] Fixing ${rows.length} songs with unknown year${artistFilter ? ' for ' + artistFilter : ''}`);

      let fixed = 0, failed = 0;
      for (const song of rows) {
        const year = await getDeezerYear(song.title, song.artist);
        if (year) {
          await pool.query('UPDATE songs SET decade = $1 WHERE id = $2', [year, song.id]);
          console.log(`[fix-years] ${song.artist} — ${song.title}: ${year}`);
          fixed++;
        } else {
          failed++;
        }
      }
      console.log(`[fix-years] Done: ${fixed} fixed, ${failed} could not resolve`);
    } catch (err) {
      console.error('[fix-years] Error:', err.message);
    }
  })();
});

// ─── GET /api/admin/debug-year ────────────────────────────────────────────────
// Shows exactly what Deezer returns for a year lookup — useful for debugging.
// Call: GET /api/admin/debug-year?title=Hello&artist=Adele&secret=X
app.get('/api/admin/debug-year', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  const hasDev = req.user && (req.user.role === 'developer' || req.user.role === 'admin');
  if (!TESTING && !hasDev && secret && req.query.secret !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { title, artist } = req.query;
  if (!title || !artist) return res.status(400).json({ error: 'Need title and artist params' });

  const KARAOKE_ALBUM_KW = ['karaoke','instrumental','backing track','tribute','in the style','made famous','originally performed','cover','sing along','minus one'];

  try {
    const q = `artist:"${artist}" track:"${title}"`;
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=20`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();

    const results = (d.data || []).map(t => ({
      title:        t.title,
      artist:       t.artist?.name,
      album:        t.album?.title,
      release_date: t.album?.release_date,
      is_karaoke:   KARAOKE_ALBUM_KW.some(kw =>
        (t.title || '').toLowerCase().includes(kw) ||
        (t.album?.title || '').toLowerCase().includes(kw) ||
        (t.artist?.name || '').toLowerCase().includes(kw)
      ),
    }));

    const nonKaraoke = results.filter(r => !r.is_karaoke);
    const bestYear = nonKaraoke.reduce((best, t) => {
      const y = parseInt((t.release_date || '').slice(0, 4));
      return (!isNaN(y) && y >= 1920 && (best === null || y < best)) ? y : best;
    }, null);

    res.json({ query: q, total: results.length, non_karaoke: nonKaraoke.length, best_year: bestYear, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Artist-locked sources list (kept in sync with catalog.js) ───────────────
// This is the canonical list of artists available in the Artist dropdown.
// An artist appears here only if catalog.js has a source with artist_lock
// for that artist. Sorted alphabetically for the dropdown.
const LOCKED_ARTISTS = [
  'ABBA', 'AC/DC', 'Adele', 'Aerosmith', 'Alicia Keys', 'Amy Winehouse',
  'Ariana Grande', 'Aretha Franklin', 'Avicii', 'Backstreet Boys', 'Beyonce',
  'Billie Eilish', 'Bon Jovi', 'Bruce Springsteen', 'Bruno Mars',
  'Calvin Harris', 'Coldplay', 'Coolio', 'Daft Punk', 'David Bowie',
  'David Guetta', 'DMX', 'Dolly Parton', 'Dr. Dre', 'Drake',
  'Dua Lipa', 'Eagles', 'Ed Sheeran', 'Elton John', 'Eminem',
  'Fleetwood Mac', 'Foo Fighters', 'Frank Ocean', 'Garth Brooks',
  'Green Day', 'Guns N\' Roses', 'Harry Styles', 'Jay-Z', 'Jimi Hendrix',
  'Johnny Cash', 'Justin Bieber', 'Justin Timberlake', 'Kanye West',
  'Kendrick Lamar', 'Kenny Rogers', 'Lady Gaga', 'Led Zeppelin',
  'Lil Nas X', 'Luke Bryan', 'Madonna', 'Mariah Carey', 'Marvin Gaye',
  'Missy Elliott', 'Morgan Wallen', 'Nas', 'Nirvana', 'NSYNC',
  'Oasis', 'Olivia Rodrigo', 'Otis Redding', 'Pearl Jam', 'Pink Floyd',
  'Post Malone', 'Prince', 'Queen', 'Rihanna', 'Rolling Stones',
  'Sam Smith', 'Shania Twain', 'Snoop Dogg', 'Spice Girls', 'SZA',
  'Taylor Swift', 'The Beatles', 'The Weeknd', 'TLC', 'Tupac', 'U2',
  'Usher', 'Van Halen', 'Warren G', 'Whitney Houston',
].sort((a, b) => {
  // Sort by effective name — strip leading "The " so "The Beatles" sorts under B
  const key = n => n.toLowerCase().replace(/^the\s+/i, '');
  return key(a).localeCompare(key(b));
});

// ─── Testing mode flag ────────────────────────────────────────────────────────
const TESTING = process.env.TESTING === 'true';

// ─── GET /api/config ──────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({ testing: TESTING, artists: LOCKED_ARTISTS });
});

// ─── GET /api/artists ─────────────────────────────────────────────────────────
// Returns distinct artists in the DB that match one of the locked artists.
// Used to only show artists that actually have songs in the current catalog.
app.get('/api/artists', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT artist FROM songs WHERE enabled = true ORDER BY artist ASC`
    );
    const inDB = new Set(rows.map(r => r.artist.toLowerCase()));
    // Return only locked artists that have at least one song in the DB
    const available = LOCKED_ARTISTS.filter(a => {
      const norm = a.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      return rows.some(r => {
        const rn = r.artist.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
        return rn.includes(norm) || norm.includes(rn);
      });
    });
    res.json({ artists: available });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/ingest ────────────────────────────────────────────────────
app.get('/api/admin/ingest', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  // Allow: TESTING mode, valid ADMIN_SECRET, or developer/admin role
  const hasDev = req.user && (req.user.role === 'developer' || req.user.role === 'admin');
  if (!TESTING && !hasDev && secret && req.query.secret !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({ message: 'Ingest started', force: req.query.force === 'true' });
  ingestFromDeezer({ force: req.query.force === 'true' }).catch(console.error);
});

// ─── GET /api/admin/reset ─────────────────────────────────────────────────────
// Truncates songs table and re-seeds. Requires TESTING mode OR dev/admin role.
app.get('/api/admin/reset', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  const hasDev = req.user && (req.user.role === 'developer' || req.user.role === 'admin');
  if (!TESTING && !hasDev && secret && req.query.secret !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    await pool.query('TRUNCATE TABLE songs RESTART IDENTITY');
    console.log('[reset] Songs table cleared — re-seeding in background');
    res.json({ message: 'Table cleared — re-seeding in background. Watch /api/health for progress.' });
    ingestFromDeezer({ force: true }).catch(console.error);
  } catch (err) {
    console.error('[reset] Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── POST /api/bug-report ─────────────────────────────────────────────────────
// Sends a bug report email via Resend API.
// Env vars needed:
//   BUG_REPORT_TO   — recipient address (your email)
//   BUG_REPORT_FROM — sender address (must be verified in Resend, e.g. bugs@yourdomain.com)
//   RESEND_API_KEY  — API key from resend.com (free tier: 3000 emails/month)
app.post('/api/bug-report', async (req, res) => {
  const { title, body } = req.body || {};
  if (!title || !body) {
    return res.status(400).json({ error: 'Title and body are required' });
  }

  const to   = process.env.BUG_REPORT_TO;
  const from = process.env.BUG_REPORT_FROM || 'bugs@tipofmytongue.app';
  const key  = process.env.RESEND_API_KEY;

  if (!to || !key) {
    console.warn('[bug-report] BUG_REPORT_TO or RESEND_API_KEY not set — logging report instead');
    console.log('[bug-report]', { title, body: body.slice(0, 200) });
    return res.json({ ok: true, method: 'logged' });
  }

  try {
    const payload = JSON.stringify({
      from,
      to,
      subject: '[TOYT Bug] ' + title,
      text: body + '\n\n---\nSubmitted via tipofmytongue.app',
    });

    const result = await new Promise((resolve, reject) => {
      const https = require('https');
      const opts = {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + key,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };
      const reqH = https.request(opts, r => {
        let data = '';
        r.on('data', d => data += d);
        r.on('end', () => resolve({ status: r.statusCode, body: data }));
      });
      reqH.on('error', reject);
      reqH.write(payload);
      reqH.end();
    });

    if (result.status === 200 || result.status === 201) {
      res.json({ ok: true });
    } else {
      console.error('[bug-report] Resend error:', result.body);
      res.status(500).json({ error: 'Email delivery failed' });
    }
  } catch (err) {
    console.error('[bug-report] Request failed:', err.message);
    res.status(500).json({ error: 'Failed to send report' });
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
    await ensureUserSchema();
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
