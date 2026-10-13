// api/index.js
import express from 'express';
import cors from 'cors';

const app = express();

/* ------------ CORS global ------------ */
function corsHeaders(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
}

app.use(cors());
app.use(corsHeaders);
app.use(express.json());

/* ------------ GitHub Config ------------ */
const GH_REPO   = process.env.GH_REPO || 'sigitars9-hue/api-gv';
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const GH_TOKEN  = process.env.GITHUB_TOKEN || '';

const DATA_FILES = ['data1.json', 'data2.json', 'data3.json'];

let __cache = { data: null, ts: 0 };

async function fetchJsonFromGithub(filename) {
  const url = `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/data/${filename}`;
  const headers = {};
  if (GH_TOKEN) headers['Authorization'] = `token ${GH_TOKEN}`;

  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      console.error(`Gagal memuat ${filename}: status ${resp.status}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    console.error(`Error fetch ${filename}:`, err);
    return null;
  }
}

async function load() {
  const now = Date.now();
  // Cache data 10 detik agar hemat kuota request GitHub
  if (__cache.data && now - __cache.ts < 10_000) {
    return __cache.data;
  }

  try {
    const results = await Promise.all(
      DATA_FILES.map((file) => fetchJsonFromGithub(file))
    );

    const merged = {
      series: [],
      chapters: {},
      announcements: [],
    };

    const seenSlugs = new Set();

    for (const json of results) {
      if (!json) continue;

      if (Array.isArray(json.series)) {
        for (const item of json.series) {
          if (item?.slug && !seenSlugs.has(item.slug)) {
            seenSlugs.add(item.slug);
            merged.series.push(item);
          }
        }
      }

      if (json.chapters && typeof json.chapters === 'object') {
        Object.assign(merged.chapters, json.chapters);
      }

      if (Array.isArray(json.announcements)) {
        merged.announcements.push(...json.announcements);
      }
    }

    __cache = { data: merged, ts: now };
    return merged;
  } catch (err) {
    console.error('Error saat merge data:', err);
    return __cache.data || { series: [], chapters: {}, announcements: [] };
  }
}

/* ------------ Helpers ------------ */
function getSeriesDate(s) {
  const ch = s?.chapters?.[0];
  const dateStr = ch?.publishedAt || ch?.createdAt || s?.updatedAt || s?.createdAt || 0;
  return new Date(dateStr).getTime() || 0;
}

function toCard(s) {
  const ch = s?.chapters?.[0];
  return {
    id: s.slug,
    slug: s.slug,
    title: s.title,
    cover: s.cover,
    updatedAt: ch?.publishedAt || ch?.createdAt || s?.updatedAt || null,
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
app.get(['/latest', '/manga/latest', '/recent'], async (req, res) => {
  const { series = [] } = await load();
  const page = parseInt(req.query.page || '1', 10);
  const pageSize = parseInt(req.query.pageSize || '20', 10);

  const sorted = [...series].sort((a, b) => getSeriesDate(b) - getSeriesDate(a));
  const start = (page - 1) * pageSize;

  res.json(sorted.slice(start, start + pageSize).map(toCard));
});

/* ===================== POPULAR ===================== */
app.get('/popular', async (req, res) => {
  const { series = [] } = await load();
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
app.get('/recommendations', async (req, res) => {
  const { series = [] } = await load();
  const typeFilter = String(req.query.type || '').toLowerCase();

  let filtered = series;
  if (typeFilter) {
    filtered = series.filter(
      (s) => String(s.type || '').toLowerCase() === typeFilter
    );
  }

  const list = filtered.length ? filtered : series;
  const items = list.slice(0, 15).map(toCard);
  res.json(items);
});

/* ================== ANNOUNCEMENTS =================== */
app.get('/announcements', async (req, res) => {
  const { announcements = [] } = await load();
  res.json(announcements);
});

/* ====================== DETAIL SERIES ====================== */
app.get(['/manga/:slug', '/series/:slug'], async (req, res) => {
  const { series = [] } = await load();
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
      banner: found.backdrop || found.cover,
      rating: found.rating || 0,
      views: found.views || 0,
      bookmarks: found.bookmarks || 0,
    },
    chapters: found.chapters || [],
  });
});

/* ===================== HALAMAN CHAPTER ===================== */
app.get(['/manga/chapter/:id', '/chapter/:id', '/chapters/:id'], async (req, res) => {
  const { chapters = {} } = await load();
  const pages = chapters[req.params.id];
  if (!pages) return res.status(404).json({ error: 'chapter not found' });
  res.json(pages);
});

/* ========================= SEARCH ========================= */
app.get('/search', async (req, res) => {
  const { series = [] } = await load();
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
app.get('/genres', async (req, res) => {
  const { series = [] } = await load();
  const set = new Set();
  series.forEach((s) => (s.genres || []).forEach((g) => set.add(String(g))));
  res.json(Array.from(set).sort((a, b) => a.localeCompare(b)));
});

app.get('/by-genre/:name', async (req, res) => {
  const { series = [] } = await load();
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

export default app;
