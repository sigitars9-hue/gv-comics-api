import express from 'express';
import cors from 'cors';
import fs from 'node:fs';

export const app = express();
app.use(cors());
app.use(express.json());

function load() {
  const raw = fs.readFileSync('./data.json', 'utf-8');
  return JSON.parse(raw);
}
function toCard(s) {
  return {
    id: s.slug, slug: s.slug, title: s.title,
    cover: s.cover, updatedAt: s.chapters?.[0]?.createdAt || null,
    badge: s.type || 'UP',
  };
}

// === routes (pindahkan semua route kamu ke sini) ===
app.get('/', (req, res) => {
  res.json({ ok: true, name: 'gv-comics-api', docs: [
    '/latest?page=1',
    '/recommendations?type=manhwa',
    '/announcements',
    '/manga/:slug',
    '/manga/chapter/:id',
    '/search?q=keyword',
    '/genres',
    '/by-genre/:name?page=1&pageSize=20',
    '/popular?range=daily|weekly|all'
  ]});
});

app.get(['/latest','/manga/latest','/recent'], (req,res)=>{
  const { series=[] } = load();
  const page = parseInt(req.query.page || '1', 10);
  const pageSize = parseInt(req.query.pageSize || '20', 10);
  const start = (page - 1) * pageSize;
  res.json(series.slice(start, start + pageSize).map(toCard));
});

app.get('/popular', (req, res) => {
  const { series=[] } = load();
  const range = String(req.query.range || 'daily').toLowerCase();
  let sorted = [...series];
  if (range === 'daily') sorted.sort((a,b)=>(b.bookmarks||0)-(a.bookmarks||0));
  else if (range === 'weekly') sorted.sort((a,b)=>(b.views||0)-(a.views||0));
  else sorted.sort((a,b)=> (b.rating||0)-(a.rating||0) || (b.views||0)-(a.views||0) || (b.bookmarks||0)-(a.bookmarks||0));
  res.json(sorted.slice(0,10).map(toCard));
});

app.get('/recommendations', (req, res) => {
  const { series=[] } = load();
  res.json(series.slice(0,15).map(s=>({ id:s.slug, slug:s.slug, title:s.title, cover:s.cover, updatedAt:null })));
});

app.get('/announcements', (req, res) => {
  const { announcements=[] } = load();
  res.json(announcements);
});

app.get(['/manga/:slug','/series/:slug'], (req,res)=>{
  const { series=[] } = load();
  const found = series.find(s=>s.slug===req.params.slug);
  if (!found) return res.status(404).json({ error:'series not found' });
  res.json({
    info: {
      slug: found.slug, title: found.title, description: found.description || '',
      type: found.type || 'Manhwa', genres: found.genres || [],
      author: found.author || '-', artist: found.artist || '-', status: found.status || 'Ongoing',
      cover: found.cover, banner: found.banner || found.cover,
      rating: found.rating || 0, views: found.views || 0, bookmarks: found.bookmarks || 0,
    },
    chapters: found.chapters || [],
  });
});

app.get(['/manga/chapter/:id','/chapter/:id','/chapters/:id'], (req,res)=>{
  const { chapters={} } = load();
  const pages = chapters[req.params.id];
  if (!pages) return res.status(404).json({ error:'chapter not found' });
  res.json(pages);
});

app.get('/search', (req,res)=>{
  const { series=[] } = load();
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  const norm = s => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g,' ').replace(/\s+/g,' ').trim();
  const terms = norm(q).split(' ').filter(Boolean);
  const hits = series.filter(s => {
    const hay = norm(s.title||'')+' '+norm(s.slug||'')+' '+norm((s.genres||[]).join(' '));
    return terms.every(t => hay.includes(t));
  });
  res.json(hits.map(s=>({ id:s.slug, slug:s.slug, title:s.title, cover:s.cover, updatedAt:s.chapters?.[0]?.createdAt || null })));
});

app.get('/genres',(req,res)=>{
  const { series=[] } = load();
  const st = new Set();
  series.forEach(s => (s.genres||[]).forEach(g=>st.add(String(g))));
  res.json(Array.from(st).sort((a,b)=>a.localeCompare(b)));
});

app.get('/by-genre/:name',(req,res)=>{
  const { series=[] } = load();
  const name = (req.params.name || '').toLowerCase();
  const page = parseInt(req.query.page || '1', 10);
  const pageSize = parseInt(req.query.pageSize || '20', 10);
  const filtered = series.filter(s => (s.genres||[]).some(g=>String(g).toLowerCase()===name));
  const start = (page - 1) * pageSize;
  res.json({ total: filtered.length, page, pageSize, items: filtered.slice(start,start+pageSize).map(toCard) });
});

app.use((req,res)=> res.status(404).json({ success:false, message:'api path not found' }));
