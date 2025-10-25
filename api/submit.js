// api/submit.js  (PROJECT: Api Komikk)  —  CommonJS + manual JSON parse
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOW_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-submit-secret');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', method: req.method });
  }

  try {
    // ---- manual parse body (hindari runtime beda2)
    let raw = '';
    await new Promise((resolve, reject) => {
      req.on('data', (c) => (raw += c));
      req.on('end', resolve);
      req.on('error', reject);
    });

    let body = {};
    const ct = (req.headers['content-type'] || '').toLowerCase();
    if (ct.includes('application/json')) {
      try { body = raw ? JSON.parse(raw) : {}; }
      catch (e) {
        console.error('Invalid JSON:', e, raw?.slice(0, 200));
        return res.status(400).json({ error: 'Invalid JSON' });
      }
    } else {
      body = raw; // fallback
    }

    // ---- auth
    const secret = req.headers['x-submit-secret'];
    if (!secret || secret !== process.env.SUBMIT_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // ---- normalisasi: dukung BARU & LEGACY (series & chapter)
    let { type, slug, data, seriesSlug, chapterSlug, mode } = body || {};
    const legacySeries  = body?.payload?.series  || body?.series;
    const legacyChapter = body?.payload?.chapter || body?.chapter;

    if (!type && legacySeries) { // legacy series
      type = 'series'; data = legacySeries; slug = legacySeries.slug;
    }
    if (!type && legacyChapter) { // legacy chapter
      type = 'chapter';
      data = {
        title: legacyChapter.title,
        pages: legacyChapter.pages,
        publishedAt: legacyChapter.publishedAt,
        thumbnail: legacyChapter.thumbnail,
      };
      chapterSlug = legacyChapter.slug || legacyChapter.chapterSlug;
      seriesSlug  = body?.payload?.series?.slug || body?.series?.slug || legacyChapter.seriesSlug || seriesSlug;
      slug = chapterSlug;
    }
    mode = mode || 'pr';

    // ---- validasi minimal
    if (!type) return res.status(400).json({ error: 'Invalid payload: type required' });
    if (type === 'series') {
      if (!slug) return res.status(400).json({ error: 'Invalid payload: series.slug required' });
      if (!data) return res.status(400).json({ error: 'Invalid payload: data required' });
    } else if (type === 'chapter') {
      if (!seriesSlug || !chapterSlug)
        return res.status(400).json({ error: 'Invalid payload: seriesSlug & chapterSlug required' });
      if (!data?.pages?.length)
        return res.status(400).json({ error: 'Invalid payload: data.pages required' });
    } else if (type === 'announcement') {
      if (!data) return res.status(400).json({ error: 'Invalid payload: data required' });
    }

    // ——— sementara echo dulu, biar tahu fungsi jalan
    console.log('submit.normalized', { type, slug, seriesSlug, chapterSlug, pages: data?.pages?.length || 0, mode });
    return res.status(200).json({
      ok: true,
      normalized: { type, slug, seriesSlug, chapterSlug, hasPages: !!data?.pages?.length, mode }
    });

    // === setelah ini stabil, baru ganti block di atas
    //     dengan kode Octokit commit/PR (yang sudah kuberi sebelumnya).
  } catch (e) {
    console.error('submit.error', e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};
