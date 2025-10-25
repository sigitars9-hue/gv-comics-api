// api/submit.js  (ROOT, CommonJS)
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOW_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-submit-secret');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // auth
    const secret = req.headers['x-submit-secret'];
    if (!secret || secret !== process.env.SUBMIT_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const body = req.body || {};

    // ---- Normalisasi: dukung format BARU & LEGACY (series & chapter)
    let { type, slug, data, seriesSlug, chapterSlug, mode } = body;
    const legacySeries  = body?.payload?.series  || body?.series;
    const legacyChapter = body?.payload?.chapter || body?.chapter;

    if (!type && legacySeries) {
      type = 'series'; data = legacySeries; slug = legacySeries.slug;
    }
    if (!type && legacyChapter) {
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

    // ---- Validasi minimal
    if (!type) return res.status(400).json({ error: 'Invalid payload: type required' });
    if (type === 'series') {
      if (!slug) return res.status(400).json({ error: 'Invalid payload: series.slug required' });
      if (!data) return res.status(400).json({ error: 'Invalid payload: data required' });
    } else if (type === 'chapter') {
      if (!seriesSlug || !chapterSlug) return res.status(400).json({ error: 'Invalid payload: seriesSlug & chapterSlug required' });
      if (!data?.pages?.length)    return res.status(400).json({ error: 'Invalid payload: data.pages required' });
    } else if (type === 'announcement') {
      if (!data) return res.status(400).json({ error: 'Invalid payload: data required' });
    }

    // sementara: echo agar yakin fungsi hidup
    return res.status(200).json({
      ok: true,
      normalized: { type, slug, seriesSlug, chapterSlug, hasPages: !!data?.pages?.length, mode }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};
