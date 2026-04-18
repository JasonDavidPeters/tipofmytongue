/**
 * Tip of Your Tongue — server.js
 *
 * Uses the Deezer API for 30-second track previews.
 * No API key or credentials required — Deezer's search endpoint is public.
 * We proxy it server-side because Deezer does not support CORS.
 */

require('dotenv').config();
const express = require('express');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Simple in-memory cache to avoid hammering Deezer for the same song ───────
const previewCache = new Map(); // q → { previewUrl, trackName, artistName, albumArt }

// ─── GET /api/preview?q=Bohemian+Rhapsody+Queen ───────────────────────────────
app.get('/api/preview', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing query param: q' });

  // Return from cache if we have it
  if (previewCache.has(q)) {
    return res.json(previewCache.get(q));
  }

  try {
    // Deezer search — no auth needed, returns 30s preview_url on most tracks
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=10`;
    const deezerRes = await fetch(url);

    if (!deezerRes.ok) {
      console.error(`Deezer error: ${deezerRes.status}`);
      return res.status(502).json({ error: 'Deezer API error', previewUrl: null });
    }

    const data   = await deezerRes.json();
    const tracks = data?.data ?? [];

    // Pick the first result that has a working preview
    let result = null;
    for (const track of tracks) {
      if (track.preview) {
        result = {
          previewUrl:  track.preview,                      // direct MP3 URL, no auth needed
          trackName:   track.title,
          artistName:  track.artist?.name ?? '',
          albumArt:    track.album?.cover_medium ?? null,
        };
        break;
      }
    }

    if (!result) {
      result = { previewUrl: null, trackName: null, artistName: null, albumArt: null };
    }

    // Cache successful results (only cache hits, not misses — misses may resolve later)
    if (result.previewUrl) previewCache.set(q, result);

    return res.json(result);

  } catch (err) {
    console.error('[/api/preview]', err.message);
    return res.status(500).json({ error: 'Internal server error', previewUrl: null });
  }
});

// ─── Health check (Render uses this to confirm the service is up) ─────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', source: 'deezer', timestamp: new Date().toISOString() });
});

// ─── Catch-all: serve the SPA ─────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🎵 Tip of Your Tongue running on http://localhost:${PORT}`);
  console.log(`   Audio source: Deezer (no credentials required)`);
});
