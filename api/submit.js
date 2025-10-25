// api/submit.js  (root project; Vercel serverless)
// Terima format BARU & LEGACY untuk series & chapter, lalu commit/PR ke GitHub.

import { Octokit } from '@octokit/rest'

/* ── util ─────────────────────────────────────────────────────────────── */
const ok = (res, data) => res.status(200).json({ ok: true, ...data })
const err = (res, code, msg) => res.status(code).json({ error: msg })
const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64')

function normalizePayload(body) {
  // Bentuk baru:
  //  { type:'series'|'chapter'|'announcement', slug, data, title?, cover?, seriesSlug?, chapterSlug?, mode? }
  // Legacy:
  //  { payload:{ series:{...} } }
  //  { payload:{ chapter:{...}, series:{ slug:'...' } } }
  //  { series:{...} } / { chapter:{...} }

  let { type, slug, data, title, cover, seriesSlug, chapterSlug, mode } = body || {}

  // Legacy SERIES?
  const legacySeries = body?.payload?.series || body?.series
  // Legacy CHAPTER?
  const legacyChapter = body?.payload?.chapter || body?.chapter

  if (!type && legacySeries && !legacyChapter) {
    type = 'series'
    data = legacySeries
    slug = legacySeries.slug
    title = legacySeries.title ?? title
    cover = legacySeries.cover ?? cover
  }

  if (!type && legacyChapter) {
    type = 'chapter'
    data = {
      title: legacyChapter.title,
      pages: legacyChapter.pages,
      publishedAt: legacyChapter.publishedAt,
      thumbnail: legacyChapter.thumbnail,
    }
    chapterSlug = legacyChapter.slug || legacyChapter.chapterSlug
    seriesSlug =
      body?.payload?.series?.slug ||
      body?.series?.slug ||
      legacyChapter.seriesSlug ||
      seriesSlug
    slug = chapterSlug
  }

  // Normalisasi kecil
  mode = mode || 'pr'

  return { type, slug, data, title, cover, seriesSlug, chapterSlug, mode }
}

/* ── handler ──────────────────────────────────────────────────────────── */
export default async function handler(req, res) {
  // CORS minimal
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOW_ORIGIN || '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-submit-secret')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return err(res, 405, 'Method not allowed')

  try {
    // Auth sederhana
    const secret = req.headers['x-submit-secret']
    if (!secret || secret !== process.env.SUBMIT_SECRET) {
      return err(res, 401, 'Unauthorized')
    }

    const body = req.body || {}
    const { type, slug, data, title, cover, seriesSlug, chapterSlug, mode } =
      normalizePayload(body)

    if (!type) return err(res, 400, 'Invalid payload: type required')

    if (type === 'series') {
      if (!slug) return err(res, 400, 'Invalid payload: series.slug required')
      if (!data) return err(res, 400, 'Invalid payload: data required')
    } else if (type === 'chapter') {
      if (!seriesSlug || !chapterSlug) {
        return err(res, 400, 'Invalid payload: seriesSlug & chapterSlug required')
      }
      if (!data?.pages || data.pages.length === 0) {
        return err(res, 400, 'Invalid payload: data.pages required')
      }
    } else if (type === 'announcement') {
      if (!data) return err(res, 400, 'Invalid payload: data required')
    }

    // ── Setup GitHub
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })
    const [owner, repo] = (process.env.GH_REPO || '').split('/')
    if (!owner || !repo) return err(res, 500, 'GH_REPO env invalid. Use owner/repo')
    const baseBranch = process.env.GH_BRANCH || 'main'
    const prefix = (process.env.PATH_PREFIX || 'data').replace(/\/+$/, '')

    // ── Bentuk path & konten
    let path
    if (type === 'series') {
      path = `${prefix}/series/${slug}.json`
    } else if (type === 'chapter') {
      path = `${prefix}/chapters/${seriesSlug}/${chapterSlug}.json`
    } else if (type === 'announcement') {
      const id = slug || `announcement-${Date.now()}`
      path = `${prefix}/announcements/${id}.json`
    } else {
      path = `${prefix}/${type}/${slug}.json`
    }

    const payload = {
      _meta: {
        type,
        slug: slug || null,
        title: title ?? data?.title ?? null,
        cover: cover ?? data?.cover ?? null,
        submittedAt: new Date().toISOString(),
      },
      ...data,
    }
    const contentStr = JSON.stringify(payload, null, 2)
    const contentB64 = b64(contentStr)

    // ── ambil file lama (jika ada) buat SHA & skip-no-change
    let oldSha = null
    try {
      const { data: existing } = await octokit.repos.getContent({
        owner, repo, path, ref: baseBranch,
      })
      if (existing?.sha) {
        oldSha = existing.sha
        if (existing.type === 'file' && existing.content) {
          const prev = Buffer.from(existing.content, 'base64').toString('utf-8')
          if (prev === contentStr) {
            return ok(res, { skipped: true, reason: 'No changes', path, branch: baseBranch })
          }
        }
      }
    } catch (_) {
      // file belum ada → create baru
    }

    // ── pilih branch target (PR vs direct)
    let targetBranch = baseBranch
    let prBranch = null
    if (mode === 'pr') {
      const { data: baseRef } = await octokit.git.getRef({ owner, repo, ref: `heads/${baseBranch}` })
      const safeSlug = (slug || (type === 'announcement' ? 'announcement' : 'item')).replace(/[^a-zA-Z0-9/_-]/g, '')
      const newBranchName = `submit/${type}/${safeSlug}/${Date.now().toString(36)}`
      await octokit.git.createRef({
        owner, repo, ref: `refs/heads/${newBranchName}`, sha: baseRef.object.sha,
      })
      targetBranch = newBranchName
      prBranch = newBranchName
    }

    const committer = {
      name: process.env.GH_COMMITTER_NAME || 'GV Submit Bot',
      email: process.env.GH_COMMITTER_EMAIL || 'bot@submit.gv',
    }
    const message = `[generator] ${type}${slug ? `:${slug}` : ''} ${oldSha ? 'update' : 'create'} (${new Date().toISOString()})`

    const resp = await octokit.repos.createOrUpdateFileContents({
      owner, repo, path, message, content: contentB64, sha: oldSha || undefined, branch: targetBranch,
      committer, author: committer,
    })

    // ── jika PR mode, buka PR
    let prUrl = null
    if (prBranch) {
      const pr = await octokit.pulls.create({
        owner, repo,
        title: `[Generator] ${type}${slug ? `: ${slug}` : ''} – ${oldSha ? 'Update' : 'Create'}`,
        head: prBranch, base: baseBranch,
        body: `Auto-PR.\n- Path: \`${path}\`\n- Tipe: \`${type}\`\n- Waktu: \`${new Date().toISOString()}\``,
        maintainer_can_modify: true,
      })
      prUrl = pr.data.html_url
    }

    return ok(res, {
      created: !oldSha,
      path,
      branch: targetBranch,
      html_url: resp?.data?.content?.html_url || null,
      commit_sha: resp?.data?.commit?.sha || null,
      pr_url: prUrl,
    })
  } catch (e) {
    return err(res, 500, e.message || 'Server error')
  }
}
