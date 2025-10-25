// api/submit.js
export default async function handler(req, res) {
  // --- CORS ---
  const ORIGINS = [
    'http://localhost:5173',
    'https://komikkk.vercel.app', // FE production
    // tambahkan custom domain FE jika ada
  ];
  const origin = req.headers.origin || '';
  const allowOrigin = ORIGINS.includes(origin) ? origin : ORIGINS[0];

  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-submit-secret');

  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // Secret simple (bisa kamu ganti JWT/OAuth nanti)
    const secret = req.headers['x-submit-secret'];
    if (!secret || secret !== process.env.SUBMIT_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // ENV yang harus ada di Vercel (Project API):
    const GH_TOKEN   = process.env.GITHUB_TOKEN;         // classic/fine-grained token
    const GH_REPO    = process.env.GH_REPO;              // format: "owner/repo", contoh "sigitars9-hue/api-gv-comics"
    const GH_BRANCH  = process.env.GH_BRANCH || 'main';  // branch target

    if (!GH_TOKEN || !GH_REPO) {
      return res.status(500).json({ error: 'Missing GitHub env' });
    }

    const payload = req.body?.payload || req.body;
    if (!payload?.series?.slug) {
      return res.status(400).json({ error: 'Invalid payload: series.slug required' });
    }

    const headers = {
      'Authorization': `token ${GH_TOKEN}`,
      'Accept': 'application/vnd.github+json'
    };

    // 1) Ambil data.json yang sekarang
    const contentsUrl = `https://api.github.com/repos/${GH_REPO}/contents/data.json?ref=${GH_BRANCH}`;
    const curResp = await fetch(contentsUrl, { headers });
    if (!curResp.ok) {
      const t = await curResp.text();
      return res.status(500).json({ error: 'Fetch data.json failed', detail: t });
    }
    const cur = await curResp.json();
    const sha = cur.sha;
    const currentJson = JSON.parse(Buffer.from(cur.content, 'base64').toString('utf8'));

    // 2) Merge data
    const out = { ...currentJson };
    out.series    = Array.isArray(out.series) ? out.series : [];
    out.chapters  = typeof out.chapters === 'object' && out.chapters ? out.chapters : {};
    out.announcements = Array.isArray(out.announcements) ? out.announcements : [];

    // replace/insert series by slug (idempotent)
    const slug = payload.series.slug;
    const idx = out.series.findIndex(s => s.slug === slug);
    if (idx >= 0) out.series[idx] = payload.series;
    else out.series.unshift(payload.series); // taruh di depan biar “terbaru”

    // merge chapters map
    if (payload.chapters && typeof payload.chapters === 'object') {
      for (const [cid, arr] of Object.entries(payload.chapters)) {
        out.chapters[cid] = Array.isArray(arr) ? arr : [];
      }
    }

    // opsional: gabung announcements
    if (Array.isArray(payload.announcements) && payload.announcements.length) {
      out.announcements = [...payload.announcements, ...out.announcements];
    }

    const newContent = Buffer.from(JSON.stringify(out, null, 2), 'utf8').toString('base64');

    // 3) Commit ke GitHub (update data.json)
    const putResp = await fetch(contentsUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `chore(data): update via generator for ${slug}`,
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
    return res.status(200).json({ ok: true, commit: ok.commit?.sha || null });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'SERVER_ERROR', detail: String(e) });
  }
}
