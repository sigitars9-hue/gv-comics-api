// api/submit.js — BE (Api Komikk)
// Mendukung submit Series (lama) + Chapter-only 

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // Auth sederhana
    const secret = req.headers['x-submit-secret'];
    if (!secret || secret !== process.env.SUBMIT_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // ENV wajib
    const GH_TOKEN  = process.env.GITHUB_TOKEN;
    const GH_REPO   = process.env.GH_REPO;              // "owner/repo"
    const GH_BRANCH = process.env.GH_BRANCH || 'main';
    if (!GH_TOKEN || !GH_REPO) {
      return res.status(500).json({ error: 'Missing GitHub env' });
    }

    // ==== Normalisasi body ====
    const raw = req.body || {};
    // format lama (series penuh): { payload: { series: {...} }, chapters?: {...} }
    const legacySeries = raw?.payload?.series || raw?.series;
    // format baru (chapter only): { type:"chapter", seriesSlug, chapterSlug, data:{...} }
    const isChapterNew =
      raw?.type === 'chapter' ||
      (raw?.seriesSlug && raw?.chapterSlug && raw?.data?.pages);

    // Flag mode
    const isSeriesLegacy = !!legacySeries && !isChapterNew;

    // ==== Ambil data.json sekarang ====
    const headers = {
      'Authorization': `token ${GH_TOKEN}`,
      'Accept': 'application/vnd.github+json'
    };
    const contentsUrl = `https://api.github.com/repos/${GH_REPO}/contents/data.json?ref=${GH_BRANCH}`;

    const curResp = await fetch(contentsUrl, { headers });
    if (!curResp.ok) {
      const t = await curResp.text();
      return res.status(500).json({ error: 'Fetch data.json failed', detail: t });
    }
    const cur = await curResp.json();
    const sha = cur.sha;
    const currentJson = JSON.parse(Buffer.from(cur.content, 'base64').toString('utf8'));

    // ==== Siapkan struktur out ====
    const out = { ...currentJson };
    out.series        = Array.isArray(out.series) ? out.series : [];
    out.chapters      = out.chapters && typeof out.chapters === 'object' ? out.chapters : {};
    out.announcements = Array.isArray(out.announcements) ? out.announcements : [];

    if (isSeriesLegacy) {
      // ========== MODE SERIES (format lama) ==========
      if (!legacySeries?.slug) {
        return res.status(400).json({ error: 'Invalid payload: series.slug required' });
      }
      const slug = legacySeries.slug;

      // replace/insert series by slug (idempotent)
      const idx = out.series.findIndex(s => s.slug === slug);
      if (idx >= 0) out.series[idx] = legacySeries;
      else out.series.unshift(legacySeries);

      // merge chapters map kalau ada di payload lama
      const legacyChapters = raw?.payload?.chapters || raw?.chapters;
      if (legacyChapters && typeof legacyChapters === 'object') {
        for (const [seriesSlugKey, arr] of Object.entries(legacyChapters)) {
          out.chapters[seriesSlugKey] = Array.isArray(arr) ? arr : [];
        }
      }
    } else if (isChapterNew) {
      // ========== MODE CHAPTER-ONLY (format baru) ==========
      const { seriesSlug, chapterSlug, data } = raw;
      if (!seriesSlug || !chapterSlug) {
        return res.status(400).json({ error: 'Invalid payload: seriesSlug & chapterSlug required' });
      }
      if (!data?.pages || !Array.isArray(data.pages) || data.pages.length === 0) {
        return res.status(400).json({ error: 'Invalid payload: data.pages required' });
      }

      // Pastikan list chapter untuk series ini ada
      const list = Array.isArray(out.chapters[seriesSlug]) ? out.chapters[seriesSlug] : [];

      // Representasi chapter yang disimpan dalam data.json
      const chObj = {
        slug: chapterSlug,
        title: data.title || `Chapter ${chapterSlug}`,
        pages: data.pages,
        publishedAt: data.publishedAt || new Date().toISOString(),
        thumbnail: data.thumbnail || (Array.isArray(data.pages) ? data.pages[0] : undefined),
      };

      const i = list.findIndex(c => (c && typeof c === 'object' && c.slug === chapterSlug));
      if (i >= 0) {
        list[i] = chObj;                // replace kalau sudah ada
      } else {
        list.unshift(chObj);            // masukkan di depan (terbaru)
      }
      out.chapters[seriesSlug] = list;
    } else {
      // Tidak cocok dua mode di atas → beri pesan jelas
      return res.status(400).json({
        error: 'Invalid payload: expected series (legacy) or chapter-only (type:"chapter").',
        hint: 'For chapter-only, send { type:"chapter", seriesSlug, chapterSlug, data:{ pages:[...], title?, publishedAt?, thumbnail? } }'
      });
    }

    // ==== Commit ke GitHub ====
    const newContent = Buffer.from(JSON.stringify(out, null, 2), 'utf8').toString('base64');

    const putResp = await fetch(contentsUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: isSeriesLegacy
          ? `chore(data): update series via generator (${legacySeries.slug})`
          : `chore(data): upsert chapter via generator (${(raw.seriesSlug + '/' + raw.chapterSlug)})`,
        content: newContent,
        sha,
        branch: GH_BRANCH,
      })
    });

    if (!putResp.ok) {
      const t = await putResp.text();
      return res.status(500).json({ error: 'GitHub commit failed', detail: t });
    }

    const ok = await putResp.json();
    return res.status(200).json({
      ok: true,
      commit: ok.commit?.sha || null,
      mode: isSeriesLegacy ? 'series' : 'chapter',
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'SERVER_ERROR', detail: String(e) });
  }
}
