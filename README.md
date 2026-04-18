# 🎵 Tip of Your Tongue v2

Music trivia with instrumental previews. Songs stored in PostgreSQL — scale to 20,000+ with a CSV import.

---

## Architecture

```
Browser → GET /api/songs?era=all&count=10   → PostgreSQL (random draw)
Browser → GET /api/preview?id=42            → Deezer karaoke/instrumental search
                                               └→ cached in DB + memory
```

**No hardcoded song arrays.** The entire catalog lives in Postgres. Adding songs = importing a CSV.

---

## Render Setup (First Time)

### 1. Create a PostgreSQL database on Render
- In your Render dashboard → New → PostgreSQL
- Free tier is fine for development
- Copy the **Internal Database URL** (use this for `DATABASE_URL` on the same Render account)

### 2. Add environment variables to your Web Service
In your Render Web Service → Environment tab:
```
DATABASE_URL=<your Internal Database URL>
NODE_ENV=production
```

### 3. Run the seed script (one time only)
After deploying, go to your Render Web Service → Shell tab:
```bash
npm run seed
```
This creates the `songs` table and inserts the initial 100-song catalog.

### 4. Verify
```bash
curl https://your-app.onrender.com/api/health
curl https://your-app.onrender.com/api/stats
```

---

## Local Development

```bash
npm install
cp .env.example .env
# Fill in DATABASE_URL pointing to your Render DB (use the External URL locally)

npm run seed    # first time only
npm run dev     # starts server with nodemon
```

---

## Adding More Songs

### Option A — Single insert
```sql
INSERT INTO songs (title, artist, era, decade, deezer_query) VALUES
  ('Waterloo', 'ABBA', '60s70s', 1974, 'artist:"ABBA" track:"Waterloo" karaoke');
```

### Option B — CSV bulk import (for 100s or 1000s of songs)
Create a CSV file `new_songs.csv`:
```csv
title,artist,era,decade,deezer_query
"Waterloo","ABBA","60s70s",1974,"artist:""ABBA"" track:""Waterloo"" karaoke"
"Jolene","Dolly Parton","60s70s",1973,"artist:""Dolly Parton"" track:""Jolene"" karaoke"
```

Then import:
```bash
psql $DATABASE_URL -c "\copy songs(title,artist,era,decade,deezer_query) FROM 'new_songs.csv' CSV HEADER"
```

### Option C — Disable a song without deleting it
```sql
UPDATE songs SET enabled = false WHERE title = 'Some Song';
```

---

## Deezer Query Tips

The `deezer_query` column controls what Deezer searches for. The format is:
```
artist:"Artist Name" track:"Song Title" karaoke
```

- Use `karaoke` for pop/vocal songs — returns karaoke versions (instrumental backing tracks)
- Use `instrumental` for rock/guitar songs — returns instrumental covers
- Both terms can be combined: `artist:"Queen" track:"Bohemian Rhapsody" karaoke instrumental`
- The server tries up to 3 fallback queries if the primary one has no preview

---

## Database Schema

```sql
CREATE TABLE songs (
  id               SERIAL PRIMARY KEY,
  title            TEXT NOT NULL,
  artist           TEXT NOT NULL,
  era              TEXT NOT NULL DEFAULT 'all',   -- 60s70s | 80s90s | 2000s | modern
  decade           SMALLINT,                       -- e.g. 1975, 1983
  deezer_query     TEXT NOT NULL,                  -- search string for Deezer API
  preview_cache    TEXT,                           -- cached Deezer preview URL
  preview_cached_at TIMESTAMPTZ,                   -- when the cache was set
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,  -- soft delete
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## API Reference

| Endpoint | Params | Description |
|---|---|---|
| `GET /api/songs` | `era`, `count` | Random songs from DB |
| `GET /api/preview` | `id` | Deezer instrumental preview URL |
| `GET /api/stats` | — | Song counts by era |
| `GET /api/health` | — | DB connectivity check |
