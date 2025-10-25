// api/submit.js (BE / Api Komikk) — urutan: CHAPTER dulu, baru SERIES (legacy)
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const secret = req.headers['x-submit-secret'];
    if (!secret || secret !== process.env.SUBMIT_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const GH_TOKEN  = process.env.GITHUB_TOKEN;
    const GH_REPO   = process.env.GH_REPO;              // "owner/repo"
    const GH_BRANCH = process.env.GH_BRANCH || 'main';
    if (!GH_TOKEN || !GH_REPO) return res.status(500).json({ error: 'Missing GitHub env' });

    // ---------- BACA BODY ----------
    const body = req.body || {};
    // format baru chapter-only
    const isChapter =
      body?.type === 'chapter' ||
      (body?.seriesSlug && body?.chapterSlug && body?.data?.pages);

    // format lama series
    const legacySeries = body?.payload?.series || body?.series;

    // ---------- AMBIL data.json ----------
    const headers = {
      'Authorization': `token ${GH_TOKEN}`,
      'Accept': 'application/vnd.github+json'
    };
    const url = `https://api.github.com/repos/${GH_REPO}/contents/data.json?ref=${GH_BRANCH}`;
    const curResp = await fetch(url, { headers });
    if (!curResp.ok) return res.status(500).json({ error: 'Fetch data.json failed', detail: await curResp.text() });
    const cur = await curResp.json();
    const sha = cur.sha;
    const current = JSON.parse(Buffer.from(cur.content, 'base64').toString('utf8'));

    // ---------- SIAPKAN OBJEK HASIL ----------
    const out = { ...current };
    out.series        = Array.isArray(out.series) ? out.series : [];
    out.chapters      = out.chapters && typeof out.chapters === 'object' ? out.chapters : {};
    out.announcements = Array.isArray(out.announcements) ? out.announcements : [];

    // ---------- MODE CHAPTER (baru) ----------
    if (isChapter) {
      const { seriesSlug, chapterSlug, data } = body;
      if (!seriesSlug || !chapterSlug) {
        return res.status(400).json({ error: 'Invalid payload: seriesSlug & chapterSlug required' });
      }
      if (!data?.pages || !Array.isArray(data.pages) || data.pages.length === 0) {
        return res.status(400).json({ error: 'Invalid payload: data.pages required' });
      }

      const list = Array.isArray(out.chapters[seriesSlug]) ? out.chapters[seriesSlug] : [];
      const chObj = {
        slug: chapterSlug,
        title: data.title || `Chapter ${chapterSlug}`,
        pages: data.pages,
        publishedAt: data.publishedAt || new Date().toISOString(),
        thumbnail: data.thumbnail || data.pages[0],
      };
      const i = list.findIndex(c => c?.slug === chapterSlug);
      if (i >= 0) list[i] = chObj; else list.unshift(chObj);
      out.chapters[seriesSlug] = list;

    // ---------- MODE SERIES (legacy) ----------
    } else if (legacySeries) {
      if (!legacySeries?.slug) {
        return res.status(400).json({ error: 'Invalid payload: series.slug required' });
      }
      const slug = legacySeries.slug;
      const idx = out.series.findIndex(s => s.slug === slug);
      if (idx >= 0) out.series[idx] = legacySeries; else out.series.unshift(legacySeries);

      const legacyChapters = body?.payload?.chapters || body?.chapters;
      if (legacyChapters && typeof legacyChapters === 'object') {
        for (const [sid, arr] of Object.entries(legacyChapters)) {
          out.chapters[sid] = Array.isArray(arr) ? arr : [];
        }
      }

    } else {
      return res.status(400).json({
        error: 'Invalid payload: send series (legacy) or chapter-only.',
        hint: 'Chapter format: { type:"chapter", seriesSlug, chapterSlug, data:{ pages:[...], title?, publishedAt?, thumbnail? } }'
      });
    }

    // ---------- COMMIT ----------
    const newContent = Buffer.from(JSON.stringify(out, null, 2), 'utf8').toString('base64');
    const putResp = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: isChapter
          ? `chore(data): upsert chapter ${body.seriesSlug}/${body.chapterSlug}`
          : `chore(data): update series ${legacySeries.slug}`,
        content: newContent,
        sha,
        branch: GH_BRANCH,
      })
    });
    if (!putResp.ok) return res.status(500).json({ error: 'GitHub commit failed', detail: await putResp.text() });

    const ok = await putResp.json();
    return res.status(200).json({
      ok: true,
      mode: isChapter ? 'chapter' : 'series',
      commit: ok.commit?.sha || null
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'SERVER_ERROR', detail: String(e) });
  }
}
