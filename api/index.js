
// api/index.js
import express from "express";
import cors from "cors";

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "2mb" }));


/* ================= API PREFIX FIX ================= */
// Mendukung URL dengan maupun tanpa prefix /api.
// Contoh: /api/series/latest -> /series/latest

app.use((req, res, next) => {
  if (req.url === "/api") {
    req.url = "/";
  } else if (req.url.startsWith("/api/")) {
    req.url = req.url.slice(4);
  }

  next();
});

const GH_REPO = process.env.GH_REPO || "sigitars9-hue/api-gv";
const GH_BRANCH = process.env.GH_BRANCH || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const BUCKETS = ["data1", "data2", "data3"];
const CACHE_TTL = 10_000;

let cache = { data: null, ts: 0 };

function emptyData() {
  return { series: [], chapters: {}, announcements: [] };
}

function validBucket(value) {
  return BUCKETS.includes(value) ? value : null;
}

function normalizeData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    data = emptyData();
  }

  if (!Array.isArray(data.series)) data.series = [];
  if (!data.chapters || typeof data.chapters !== "object" || Array.isArray(data.chapters)) {
    data.chapters = {};
  }
  if (!Array.isArray(data.announcements)) data.announcements = [];

  return data;
}

function makeSlug(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function getSeriesDate(series) {
  const chapter = series?.chapters?.[0];
  const date =
    chapter?.publishedAt ||
    chapter?.createdAt ||
    series?.updatedAt ||
    series?.createdAt ||
    0;

  return new Date(date).getTime() || 0;
}


function toCard(series) {
  const chapter = series?.chapters?.[0];

  return {
    id: series.slug,
    slug: series.slug,
    title: series.title,
    cover: series.cover,
    updatedAt:
      chapter?.publishedAt ||
      chapter?.createdAt ||
      series?.updatedAt ||
      null,
    badge: series.type || "UP",

    // Sertakan genre dan tag agar bisa difilter di frontend
    genres: Array.isArray(series.genres) ? series.genres : [],
    tags: Array.isArray(series.tags) ? series.tags : [],
  };
}


/* ================= PUBLIC DATA READER ================= */

async function fetchPublicBucket(bucket) {
  const url =
    `https://raw.githubusercontent.com/${GH_REPO}/` +
    `${GH_BRANCH}/data/${bucket}.json`;

  const response = await fetch(url);

  if (!response.ok) {
    console.error(`Gagal membaca ${bucket}.json: HTTP ${response.status}`);
    return null;
  }

  return normalizeData(await response.json());
}

async function loadBucket(bucket) {
  const data = await fetchPublicBucket(bucket);

  if (!data) {
    throw new Error(`Tidak dapat membaca data/${bucket}.json dari GitHub.`);
  }

  return data;
}

async function load() {
  const now = Date.now();

  if (cache.data && now - cache.ts < CACHE_TTL) {
    return cache.data;
  }

  
  const results = await Promise.all(
    BUCKETS.map(async (bucket) => {
      try {
        const data = await fetchPublicBucket(bucket);

        if (!data) {
          console.error(
            `[GitHub] ${bucket}.json gagal dibaca. ` +
            `Periksa HTTP status pada log sebelumnya.`
          );
        }

        return data;
      } catch (error) {
        console.error(
          `[GitHub] ${bucket}.json:`,
          error.message
        );
        return null;
      }
    })
  );

  const successfulBuckets = results.filter(Boolean).length;

  if (successfulBuckets === 0) {
    throw new Error(
      `Gagal membaca semua file: ${GH_REPO}, branch ${GH_BRANCH}. ` +
      `Periksa log HTTP 404/403 atau error parsing JSON di Vercel.`
    );
  }


if (successfulBuckets === 0) {
  throw new Error(
    "Semua file data gagal dibaca dari GitHub. Periksa URL repository, branch, dan file JSON."
  );
}
  const merged = emptyData();
  const seenSlugs = new Set();

  for (const data of results) {
    if (!data) continue;

    for (const item of data.series) {
      if (item?.slug && !seenSlugs.has(item.slug)) {
        seenSlugs.add(item.slug);
        merged.series.push(item);
      }
    }

    Object.assign(merged.chapters, data.chapters);
    merged.announcements.push(...data.announcements);
  }

  cache = { data: merged, ts: now };
  return merged;
}

/* ================= GITHUB WRITE HELPERS ================= */

function githubHeaders(extra = {}) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${GH_TOKEN}`,
    ...extra,
  };
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({
      error: "ADMIN_TOKEN belum diatur pada environment backend.",
    });
  }

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({
      error: "Token admin tidak valid.",
    });
  }

  if (!GH_TOKEN) {
    return res.status(503).json({
      error: "GITHUB_TOKEN belum diatur pada environment backend.",
    });
  }

  next();
}

function getRequestBucket(req) {
  return validBucket(
    String(req.body?.bucket || req.query?.bucket || "data1")
  );
}

async function githubGetBucket(bucket) {
  const path = `data/${bucket}.json`;
  const url =
    `https://api.github.com/repos/${GH_REPO}/contents/${path}` +
    `?ref=${encodeURIComponent(GH_BRANCH)}`;

  const response = await fetch(url, {
    headers: githubHeaders(),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      body.message ||
      `Gagal membaca ${path} dari GitHub (HTTP ${response.status}).`
    );
  }

  const content = Buffer.from(
    body.content || "",
    "base64"
  ).toString("utf8");

  let data;

  try {
    data = JSON.parse(content);
  } catch {
    throw new Error(`${path} bukan JSON yang valid.`);
  }

  return {
    sha: body.sha,
    data: normalizeData(data),
  };
}

async function githubSaveBucket(bucket, data, sha, message) {
  const path = `data/${bucket}.json`;
  const url =
    `https://api.github.com/repos/${GH_REPO}/contents/${path}`;

  const payload = {
    message,
    branch: GH_BRANCH,
    content: Buffer.from(
      JSON.stringify(data, null, 2) + "\n",
      "utf8"
    ).toString("base64"),
    sha,
  };

  const response = await fetch(url, {
    method: "PUT",
    headers: githubHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      body.message ||
      `Gagal menyimpan ${path} ke GitHub (HTTP ${response.status}).`
    );
  }

  cache = { data: null, ts: 0 };

  return body;
}


const bucketQueues = new Map();

async function mutateBucket(bucket, message, callback) {
  const previous = bucketQueues.get(bucket) || Promise.resolve();

  const current = previous.then(async () => {
    const { data, sha } = await githubGetBucket(bucket);
    const result = await callback(data);

    await githubSaveBucket(bucket, data, sha, message);

    return result;
  });

  // Simpan antrean yang tetap berjalan walaupun operasi gagal,
  // agar satu error tidak memblokir operasi berikutnya.
  bucketQueues.set(
    bucket,
    current.then(
      () => undefined,
      () => undefined
    )
  );

  return current;
}


/* ================= ROOT ================= */

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "gv-comics-api",
    endpoints: [
      "/latest",
      "/series/latest",
      "/series/:slug/chapters",
      "/chapter/:id",
      "/search",
      "/genres",
      "/by-genre/:name",
    ],
  });
});

/* ================= LATEST ================= */

app.get(["/latest", "/manga/latest", "/recent"], async (req, res) => {
  try {
    const { series } = await load();

    const page = Math.max(
      1,
      Number.parseInt(req.query.page || "1", 10) || 1
    );

    const pageSize = Math.min(
      200,
      Math.max(1, Number.parseInt(req.query.pageSize || "20", 10) || 20)
    );

    const sorted = [...series].sort(
      (a, b) => getSeriesDate(b) - getSeriesDate(a)
    );

    const start = (page - 1) * pageSize;

    res.json(sorted.slice(start, start + pageSize).map(toCard));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ================= ADMIN SERIES LIST ================= */


/* ================= ADMIN SERIES LIST ================= */

app.get("/series/latest", async (req, res) => {
  try {
    let series;

    if (req.query.bucket) {
      const bucket = validBucket(String(req.query.bucket));

      if (!bucket) {
        return res.status(400).json({
          error: "Bucket harus data1, data2, atau data3.",
        });
      }

      const data = await loadBucket(bucket);
      series = data.series;
    } else {
      ({ series } = await load());
    }

    const page = Math.max(
      1,
      Number.parseInt(req.query.page || "1", 10) || 1
    );

    const pageSize = Math.min(
      2000,
      Math.max(
        1,
        Number.parseInt(req.query.pageSize || "2000", 10) || 2000
      )
    );

    const sorted = [...series].sort(
      (a, b) => getSeriesDate(b) - getSeriesDate(a)
    );

    const start = (page - 1) * pageSize;

    res.json({
      items: sorted.slice(start, start + pageSize),
      total: sorted.length,
      page,
      pageSize,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


/* ================= POPULAR ================= */

app.get("/popular", async (req, res) => {
  try {
    const { series } = await load();
    const range = String(req.query.range || "daily").toLowerCase();

    const sorted = [...series];

    if (range === "daily") {
      sorted.sort((a, b) => (b.bookmarks || 0) - (a.bookmarks || 0));
    } else if (range === "weekly") {
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
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ================= RECOMMENDATIONS ================= */

app.get("/recommendations", async (req, res) => {
  try {
    const { series } = await load();
    const type = String(req.query.type || "").toLowerCase();

    const filtered = type
      ? series.filter((s) => String(s.type || "").toLowerCase() === type)
      : series;

    res.json((filtered.length ? filtered : series).slice(0, 15).map(toCard));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ================= ANNOUNCEMENTS ================= */

app.get("/announcements", async (_req, res) => {
  try {
    const { announcements } = await load();
    res.json(announcements);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ================= SERIES DETAIL ================= */

app.get(["/manga/:slug", "/series/:slug"], async (req, res, next) => {
  if (req.params.slug === "latest") return next();

  try {
    const { series } = await load();
    const found = series.find((s) => s.slug === req.params.slug);

    if (!found) {
      return res.status(404).json({ error: "series not found" });
    }

    res.json({
      info: {
        slug: found.slug,
        title: found.title,
        description: found.description || "",
        type: found.type || "Manhwa",
        genres: found.genres || [],
        author: found.author || "-",
        artist: found.artist || "-",
        status: found.status || "Ongoing",
        cover: found.cover,
        banner: found.backdrop || found.cover,
        rating: found.rating || 0,
        views: found.views || 0,
        bookmarks: found.bookmarks || 0,
      },
      chapters: found.chapters || [],
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ================= CHAPTER DETAIL ================= */

app.get(
  ["/manga/chapter/:id", "/chapter/:id", "/chapters/:id"],
  async (req, res) => {
    try {
      const { chapters } = await load();
      const found = chapters[req.params.id];

      if (!found) {
        return res.status(404).json({ error: "chapter not found" });
      }

      res.json(
        Array.isArray(found)
          ? { id: req.params.id, pages: found }
          : found
      );
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

/* ================= SEARCH ================= */

app.get("/search", async (req, res) => {
  try {
    const { series } = await load();
    const query = String(req.query.q || "").trim();

    if (!query) return res.json([]);

    const normalize = (value) =>
      String(value)
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^\w\s-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const terms = normalize(query).split(" ").filter(Boolean);

    const result = series.filter((s) => {
      const haystack =
        normalize(s.title || "") +
        " " +
        normalize(s.slug || "") +
        " " +
        normalize((s.genres || []).join(" "));

      return terms.every((term) => haystack.includes(term));
    });

    res.json(result.map(toCard));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ================= GENRES ================= */

app.get("/genres", async (_req, res) => {
  try {
    const { series } = await load();
    const genres = new Set();

    series.forEach((s) =>
      (s.genres || []).forEach((g) => genres.add(String(g)))
    );

    res.json([...genres].sort((a, b) => a.localeCompare(b)));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ================= FILTER BY GENRE ================= */

app.get("/by-genre/:name", async (req, res) => {
  try {
    const { series } = await load();
    const name = decodeURIComponent(req.params.name || "").toLowerCase();

    const page = Math.max(
      1,
      Number.parseInt(req.query.page || "1", 10) || 1
    );

    const pageSize = Math.min(
      200,
      Math.max(1, Number.parseInt(req.query.pageSize || "20", 10) || 20)
    );

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
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ================= CHAPTER LIST ================= */

app.get("/series/:slug/chapters", async (req, res) => {
  try {
    const { series } = await load();
    const found = series.find((s) => s.slug === req.params.slug);

    if (!found) {
      return res.status(404).json({ error: "Series tidak ditemukan." });
    }

    const chapters = Array.isArray(found.chapters)
      ? [...found.chapters]
      : [];

    chapters.sort(
      (a, b) => Number(a.number || 0) - Number(b.number || 0)
    );

    res.json({ items: chapters });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ================= SAVE / UPDATE SERIES ================= */

app.post("/admin/series", requireAdmin, async (req, res) => {
  try {
    const bucket = getRequestBucket(req);

    if (!bucket) {
      return res.status(400).json({
        error: "Bucket harus data1, data2, atau data3.",
      });
    }

    
const input = req.body || {};
const originalSlug = makeSlug(input.originalSlug || input.slug || "");
const slug = makeSlug(input.slug || input.title || "");

if (!String(input.title || "").trim() || !slug) {
  return res.status(400).json({
    error: "Judul dan slug wajib diisi.",
  });
}

const saved = await mutateBucket(
  bucket,
  `Save series ${slug}`,
  (data) => {
    const index = data.series.findIndex(
      (s) => s.slug === originalSlug
    );

    const previous = index >= 0 ? data.series[index] : null;

    // Jika sedang edit, series lama wajib ditemukan.
    if (input.originalSlug && !previous) {
      throw new Error(
        `Series '${originalSlug}' tidak ditemukan di ${bucket}.`
      );
    }

    // Cegah slug bertabrakan dengan series lain.
    const duplicate = data.series.some(
      (s, i) => s.slug === slug && i !== index
    );

    if (duplicate) {
      throw new Error(`Slug '${slug}' sudah digunakan.`);
    }

    // Jangan simpan originalSlug sebagai properti series.
    const {
      originalSlug: _originalSlug,
      bucket: _bucket,
      ...fields
    } = input;

    const item = {
      ...(previous || {}),
      ...fields,
      title: String(input.title).trim(),
      slug,
      description: String(input.description || ""),
      genres: Array.isArray(input.genres) ? input.genres : [],
      tags: Array.isArray(input.tags) ? input.tags : [],
      chapters: previous?.chapters || [],
      createdAt: previous?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (index >= 0) {
      data.series[index] = item;
    } else {
      data.series.push(item);
    }

    return item;
  }
);

res.json({ ok: true, series: saved, bucket });

  } catch (error) {
  const message = error.message || "Terjadi kesalahan server.";

  let status = 500;

  if (message.includes("tidak ditemukan")) {
    status = 404;
  } else if (
    message.includes("sudah digunakan") ||
    message.includes("wajib diisi") ||
    message.includes("tidak valid")
  ) {
    status = 400;
  }

  res.status(status).json({ error: message });
}
});

/* ================= SAVE / UPDATE CHAPTER ================= */

app.post("/admin/series/:slug/chapters", requireAdmin, async (req, res) => {
  try {
    const bucket = getRequestBucket(req);

    if (!bucket) {
      return res.status(400).json({
        error: "Bucket harus data1, data2, atau data3.",
      });
    }

    const slug = req.params.slug;
    const input = req.body || {};
    const number = Number(input.number);

    if (!Number.isFinite(number) || number < 0) {
      return res.status(400).json({
        error: "Nomor chapter tidak valid.",
      });
    }

    if (input.type === "comic" && !input.pages?.length) {
      return res.status(400).json({
        error: "Chapter komik harus memiliki minimal satu halaman.",
      });
    }

    if (input.type === "novel" && !String(input.content || "").trim()) {
      return res.status(400).json({
        error: "Isi novel tidak boleh kosong.",
      });
    }

    const saved = await mutateBucket(
      bucket,
      `Save chapter ${slug} ${number}`,
      (data) => {
        const series = data.series.find((s) => s.slug === slug);

        if (!series) {
          throw new Error(`Series '${slug}' tidak ditemukan di ${bucket}.`);
        }

        

if (!Array.isArray(series.chapters)) {
  series.chapters = [];
}

if (
  !data.chapters ||
  typeof data.chapters !== "object" ||
  Array.isArray(data.chapters)
) {
  data.chapters = {};
}

// Cari chapter lama berdasarkan nomor.
const existingMatches = series.chapters.filter(
  (item) => Number(item.number) === number
);

const previous = existingMatches[0] || {};

// Utamakan ID chapter lama agar ID tidak berubah saat update.
const id = previous.id || input.id || `${slug}-${number}`;

const chapter = {
  ...previous,
  ...input,
  id,
  number,
  title: String(input.title || `Chapter ${number}`),
  publishedAt:
    input.publishedAt ||
    previous.publishedAt ||
    new Date().toISOString(),
  thumbnail:
    input.thumbnail ||
    input.pages?.[0] ||
    previous.thumbnail ||
    "",
  bucket,
};

// Hapus entri lama berdasarkan nomor yang sama.
series.chapters = series.chapters.filter(
  (item) => Number(item.number) !== number
);

// Masukkan satu versi chapter yang terbaru.
series.chapters.push(chapter);

series.chapters.sort(
  (a, b) => Number(a.number || 0) - Number(b.number || 0)
);

// Sinkronkan indeks chapter.
// Bersihkan ID lama yang sudah tidak dipakai oleh chapter di series ini.
for (const oldChapter of existingMatches) {
  if (oldChapter.id && oldChapter.id !== id) {
    delete data.chapters[oldChapter.id];
  }
}

data.chapters[id] = chapter;

series.updatedAt = new Date().toISOString();

return chapter;


        series.updatedAt = new Date().toISOString();

        return chapter;
      }
    );

    res.json({ ok: true, chapter: saved, bucket });
  } catch (error) {
    const status = error.message?.includes("tidak ditemukan") ? 404 : 500;
    res.status(status).json({ error: error.message });
  }
});

/* ================= DELETE SERIES ================= */

app.delete("/admin/series/:slug", requireAdmin, async (req, res) => {
  try {
    const bucket = getRequestBucket(req);

    if (!bucket) {
      return res.status(400).json({
        error: "Bucket harus data1, data2, atau data3.",
      });
    }

    const slug = req.params.slug;

    const deleted = await mutateBucket(
      bucket,
      `Delete series ${slug}`,
      (data) => {
        const index = data.series.findIndex((s) => s.slug === slug);

        if (index < 0) {
          throw new Error(`Series '${slug}' tidak ditemukan di ${bucket}.`);
        }

        const [removed] = data.series.splice(index, 1);

        for (const chapter of removed.chapters || []) {
          if (chapter?.id) delete data.chapters[chapter.id];
        }

        return { slug: removed.slug };
      }
    );

    res.json({ ok: true, deleted, bucket });
  } catch (error) {
    const status = error.message?.includes("tidak ditemukan") ? 404 : 500;
    res.status(status).json({ error: error.message });
  }
});

/* ================= DELETE CHAPTER ================= */

app.delete(
  "/admin/series/:slug/chapters/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const bucket = getRequestBucket(req);

      if (!bucket) {
        return res.status(400).json({
          error: "Bucket harus data1, data2, atau data3.",
        });
      }

      const { slug, id } = req.params;

      const deleted = await mutateBucket(
        bucket,
        `Delete chapter ${id}`,
        (data) => {
          const series = data.series.find((s) => s.slug === slug);

          if (!series) {
            throw new Error(`Series '${slug}' tidak ditemukan di ${bucket}.`);
          }

          const index = (series.chapters || []).findIndex(
            (chapter) =>
              chapter.id === id || String(chapter.number) === id
          );

          if (index < 0) {
            throw new Error(`Chapter '${id}' tidak ditemukan.`);
          }

          const [removed] = series.chapters.splice(index, 1);

          if (removed.id) delete data.chapters[removed.id];

          series.updatedAt = new Date().toISOString();

          return { id: removed.id || id };
        }
      );

      res.json({ ok: true, deleted, bucket });
    } catch (error) {
      const status = error.message?.includes("tidak ditemukan") ? 404 : 500;
      res.status(status).json({ error: error.message });
    }
  }
);

/* ================= UNKNOWN ENDPOINT ================= */

app.use((req, res) => {
  res.status(404).json({
    error: `Endpoint tidak ditemukan: ${req.method} ${req.path}`,
  });
});

export default app;
