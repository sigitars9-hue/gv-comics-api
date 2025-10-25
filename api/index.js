// api/index.js
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';

const app = express();

/* ------------ CORS global (wajib di Vercel) ------------ */
function corsHeaders(req, res, next) {
  // kalau mau spesifik, ganti '*' jadi 'http://localhost:5173' dan domain produksi kamu
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
}

app.use(cors());        // tetap boleh
app.use(corsHeaders);   // pastikan header selalu ada

app.use(express.json());

/* ------------ Load data ------------ */
// Taruh data.json di root repo (sejajar vercel.json)
// ─── Ganti fungsi load() lama ───

// ENV yang harus kamu isi di Vercel Project Settings:
// GH_REPO="owner/repo"          contoh: "sigitars9-hue/api-gv-comics"
// GH_BRANCH="main"              (default boleh tetap 'main')
// GITHUB_TOKEN (optional, untuk rate limit tinggi)

const GH_REPO   = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const GH_TOKEN  = process.env.GITHUB_TOKEN || '';

const RAW_URL = `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/data.json`;

let __cache = { etag: null, data: null, ts: 0 };

async function load() {
  // fallback lokal kalau env belum di-set (mis. saat dev di localhost)
  if (!GH_REPO) {
    const raw = fs.readFileSync(DATA_PATH, 'utf-8');
    return JSON.parse(raw);
  }

  // cache 10 detik
  const now = Date.now();
  if (__cache.data && now - __cache.ts < 10_000) return __cache.data;

  const headers = {};
  if (GH_TOKEN) headers['Authorization'] = `token ${GH_TOKEN}`;
  if (__cache.etag) headers['If-None-Match'] = __cache.etag;

  const resp = await fetch(RAW_URL, { headers });

  if (resp.status === 304 && __cache.data) {
    __cache.ts = now;
    return __cache.data;
  }

  if (!resp.ok) {
    // fallback terakhir ke cache atau file lokal
    if (__cache.data) return __cache.data;
    const raw = fs.readFileSync(DATA_PATH, 'utf-8');
    return JSON.parse(raw);
  }

  const text = await resp.text();
  const json = JSON.parse(text);

  __cache = {
    etag: resp.headers.get('etag'),
    data: json,
    ts: now,
  };

  return json;
}


/* ------------ Utils ------------ */
function toCard(s) {
  return {
    id: s.slug,
    slug: s.slug,
    title: s.title,
    cover: s.cover,
    updatedAt: s.chapters?.[0]?.createdAt || null,
    badge: s.type || 'UP',
  };
}

/* ------------ Routes ------------ */

// Root
app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'gv-comics-api',
    docs: [
      '/latest?page=1',
      '/recommendations?type=manhwa',
      '/announcements',
      '/manga/:slug',
      '/manga/chapter/:id',
      '/search?q=keyword',
      '/genres',
      '/by-genre/:name?page=1&pageSize=20',
      '/popular?range=daily|weekly|all',
    ],
  });
});

/* ===================== LATEST ===================== */
app.get(['/latest', '/manga/latest', '/recent'], (req, res) => {
  const { series = [] } = load();
  const page = parseInt(req.query.page || '1', 10);
  const pageSize = parseInt(req.query.pageSize || '20', 10);
  const start = (page - 1) * pageSize;
  const items = series.slice(start, start + pageSize).map(toCard);
  res.json(items);
});

/* ===================== POPULAR ===================== */
app.get('/popular', (req, res) => {
  const { series = [] } = load();
  const range = String(req.query.range || 'daily').toLowerCase();
  let sorted = [...series];

  if (range === 'daily') {
    sorted.sort((a, b) => (b.bookmarks || 0) - (a.bookmarks || 0));
  } else if (range === 'weekly') {
    sorted.sort((a, b) => (b.views || 0) - (a.views || 0));
  } else {
    sorted.sort(
      (a, b) =>
        (b.rating || 0) - (a.rating || 0) ||
        (b.views || 0) - (a.views || 0) ||
        (b.bookmarks || 0) - (a.bookmarks || 0)
    );
  }

  res.json(sorted.slice(0, 10).map(toCard));
});

/* ================== RECOMMENDATIONS ================= */
app.get('/recommendations', (req, res) => {
  const { series = [] } = load();
  const items = series.slice(0, 15).map((s) => ({
    id: s.slug,
    slug: s.slug,
    title: s.title,
    cover: s.cover,
    updatedAt: null,
  }));
  res.json(items);
});

/* ================== ANNOUNCEMENTS =================== */
app.get('/announcements', (req, res) => {
  const { announcements = [] } = load();
  res.json(announcements);
});

/* ====================== DETAIL SERIES ====================== */
app.get(['/manga/:slug', '/series/:slug'], (req, res) => {
  const { series = [] } = load();
  const found = series.find((s) => s.slug === req.params.slug);
  if (!found) return res.status(404).json({ error: 'series not found' });

  res.json({
    info: {
      slug: found.slug,
      title: found.title,
      description: found.description || '',
      type: found.type || 'Manhwa',
      genres: found.genres || [],
      author: found.author || '-',
      artist: found.artist || '-',
      status: found.status || 'Ongoing',
      cover: found.cover,
      banner: found.banner || found.cover,
      rating: found.rating || 0,
      views: found.views || 0,
      bookmarks: found.bookmarks || 0,
    },
    chapters: found.chapters || [],
  });
});

/* ===================== HALAMAN CHAPTER ===================== */
app.get(['/manga/chapter/:id', '/chapter/:id', '/chapters/:id'], (req, res) => {
  const { chapters = {} } = load();
  const pages = chapters[req.params.id];
  if (!pages) return res.status(404).json({ error: 'chapter not found' });
  res.json(pages);
});

/* ========================= SEARCH ========================= */
app.get('/search', (req, res) => {
  const { series = [] } = load();
  const qRaw = String(req.query.q || '').trim();
  if (!qRaw) return res.json([]);

  const norm = (s) =>
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const terms = norm(qRaw).split(' ').filter(Boolean);

  const hits = series.filter((s) => {
    const hay =
      norm(s.title || '') +
      ' ' +
      norm(s.slug || '') +
      ' ' +
      norm((s.genres || []).join(' '));
    return terms.every((t) => hay.includes(t));
  });

  res.json(hits.map(toCard));
});

/* ========================= GENRES ========================= */
app.get('/genres', (req, res) => {
  const { series = [] } = load();
  const set = new Set();
  series.forEach((s) => (s.genres || []).forEach((g) => set.add(String(g))));
  res.json(Array.from(set).sort((a, b) => a.localeCompare(b)));
});

app.get('/by-genre/:name', (req, res) => {
  const { series = [] } = load();
  const name = (req.params.name || '').toLowerCase();
  const page = parseInt(req.query.page || '1', 10);
  const pageSize = parseInt(req.query.pageSize || '20', 10);

  const filtered = series.filter((s) =>
    (s.genres || []).some((g) => String(g).toLowerCase() === name)
  );

  const start = (page - 1) * pageSize;
  res.json({
    total: filtered.length,
    page,
    pageSize,
    items: filtered.slice(start, start + pageSize).map(toCard),
  });
});

/* ------------ Export handler untuk Vercel ------------ */
// ⚠️ Jangan app.listen() di Vercel.
// Cukup export default app.
export default app;
