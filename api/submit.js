// api/submit.js — mendukung Series (legacy) + Chapter-only (menulis ke series[].chapters[])
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

    // ENV GitHub
    const GH_TOKEN  = process.env.GITHUB_TOKEN;
    const GH_REPO   = process.env.GH_REPO;              // "owner/repo"
    const GH_BRANCH = process.env.GH_BRANCH || 'main';
    if (!GH_TOKEN || !GH_REPO) {
      return res.status(500).json({ error: 'Missing GitHub env' });
    }

    // -------- Normalisasi body --------
    const body = req.body || {};
    // Series (format lama)
    const legacySeries = body?.payload?.series || body?.series;
    // Chapter-only (format baru)
    const isChapterOnly =
      body?.type === 'chapter' ||
      (body?.seriesSlug && body?.chapterSlug && body?.data?.pages);

    // -------- Ambil data.json saat ini --------
    const headers = {
      'Authorization': `token ${GH_TOKEN}`,
      'Accept': 'application/vnd.github+json'
    };
    const url = `https://api.github.com/repos/${GH_REPO}/contents/data.json?ref=${GH_BRANCH}`;

    const curResp = await fetch(url, { headers });
    if (!curResp.ok) {
      const t = await curResp.text();
      return res.status(500).json({ error: 'Fetch data.json failed', detail: t });
    }
    const cur = await curResp.json();
    const sha = cur.sha;
    const current = JSON.parse(Buffer.from(cur.content, 'base64').toString('utf8'));

    // Pastikan shape dasar
    const out = { ...current };
    out.series        = Array.isArray(out.series) ? out.series : [];
    out.announcements = Array.isArray(out.announcements) ? out.announcements : [];
    // (DI FILE KAMU, top-level "chapters" tidak dipakai — biarkan apa adanya)

    // ========== MODE CHAPTER-ONLY ==========
    if (isChapterOnly) {
      const { seriesSlug, chapterSlug, data } = body;

      if (!seriesSlug || !chapterSlug) {
        return res.status(400).json({ error: 'Invalid payload: seriesSlug & chapterSlug required' });
      }
      if (!data?.pages || !Array.isArray(data.pages) || data.pages.length === 0) {
        return res.status(400).json({ error: 'Invalid payload: data.pages required' });
      }

      // Cari series berdasarkan slug
      const sIdx = out.series.findIndex(s => s?.slug === seriesSlug);
      if (sIdx < 0) {
        return res.status(404).json({
          error: 'Series not found',
          detail: `Series "${seriesSlug}" belum ada di data.json. Buat dulu via tombol hijau.`
        });
      }

      const series = out.series[sIdx];
      series.chapters = Array.isArray(series.chapters) ? series.chapters : [];

      // Bentuk chapter sesuai skema data.json milikmu
      const pad3 = (n) => String(n).padStart(3, '0');

      // Tentukan id & number
      const numberFromSlug =
        Number((chapterSlug.match(/(\d+)$/) || [])[1] || NaN);
      const number =
        Number.isFinite(data?.number) ? Number(data.number)
        : Number.isFinite(numberFromSlug) ? numberFromSlug
        : 1;

      const id = data?.id || `${seriesSlug}-${pad3(number)}`;

      const chObj = {
        id,
        number,
        title: data?.title || `Chapter ${number}`,
        pages: data.pages,
        publishedAt: data?.publishedAt || new Date().toISOString(),
        thumbnail: data?.thumbnail || data.pages[0],
      };

      // Replace by id kalau sudah ada, else unshift
      const cIdx = series.chapters.findIndex(c => c?.id === id);
      if (cIdx >= 0) series.chapters[cIdx] = chObj;
      else series.chapters.unshift(chObj);

      out.series[sIdx] = series; // simpan balik

    // ========== MODE SERIES (legacy) ==========
    } else if (legacySeries) {
      if (!legacySeries?.slug) {
        return res.status(400).json({ error: 'Invalid payload: series.slug required' });
      }
      const slug = legacySeries.slug;

      // Pastikan chapters legacy tetap array
      legacySeries.chapters = Array.isArray(legacySeries.chapters) ? legacySeries.chapters : [];

      const idx = out.series.findIndex(s => s.slug === slug);
      if (idx >= 0) out.series[idx] = legacySeries;
      else out.series.unshift(legacySeries);

      // (Top-level "chapters" di file kamu tidak dipakai — skip merge)

    } else {
      return res.status(400).json({
        error: 'Invalid payload',
        hint: 'Kirim salah satu: (1) payload.series (legacy), atau (2) { type:"chapter", seriesSlug, chapterSlug, data:{ pages:[...], title?, number?, publishedAt?, thumbnail? } }'
      });
    }

    // -------- Commit ke GitHub --------
    const newContent = Buffer.from(JSON.stringify(out, null, 2), 'utf8').toString('base64');
    const putResp = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: isChapterOnly
          ? `chore(data): upsert chapter ${body.seriesSlug}/${body.chapterSlug}`
          : `chore(data): update series ${legacySeries.slug}`,
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
      mode: isChapterOnly ? 'chapter' : 'series',
      commit: ok.commit?.sha || null
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'SERVER_ERROR', detail: String(e) });
  }
}
