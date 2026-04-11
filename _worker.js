/**
 * MOVXIO — Cloudflare Pages Edge Worker
 * File: _worker.js (place in repo root alongside index.html)
 *
 * Handles two routes:
 *   1. GET /sitemap.xml        → auto-generated from Supabase films
 *   2. GET /watch.html?id=...  → dynamic OG meta for social sharing
 *
 * Everything else passes through untouched.
 * Safe to remove at any time — just delete this file and push.
 */

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://kncqgatjjcezlnwwikqm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtuY3FnYXRqamNlemxud3dpa3FtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNjUxMzMsImV4cCI6MjA5MDY0MTEzM30.irNGQnC6SlSq2ozVHToq1TnBAs_fKdukJMPmaMB1wyc';
const SITE_URL     = 'https://movxio.com';
const SITE_NAME    = 'MOVXIO';
const DEFAULT_IMG  = `${SITE_URL}/og-default.jpg`;

// ─────────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────────
function supaHeaders() {
  return {
    'apikey':          SUPABASE_KEY,
    'Authorization':   `Bearer ${SUPABASE_KEY}`,
    'Cache-Control':   'no-cache',
  };
}

function toISODate(str) {
  try { return new Date(str).toISOString().slice(0, 10); }
  catch { return new Date().toISOString().slice(0, 10); }
}

function escXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─────────────────────────────────────────────────────────────
// ROUTE 1 — SITEMAP
// ─────────────────────────────────────────────────────────────
const STATIC_PAGES = [
  { loc: '/',             changefreq: 'daily',   priority: '1.0' },
  { loc: '/browse.html',  changefreq: 'daily',   priority: '0.9' },
  { loc: '/search.html',  changefreq: 'weekly',  priority: '0.8' },
  { loc: '/about.html',   changefreq: 'monthly', priority: '0.5' },
  { loc: '/privacy.html', changefreq: 'monthly', priority: '0.3' },
  { loc: '/terms.html',   changefreq: 'monthly', priority: '0.3' },
  { loc: '/dmca.html',    changefreq: 'monthly', priority: '0.3' },
];

async function fetchAllFilms() {
  const films = [];
  let offset  = 0;
  const limit = 1000;

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/films`
      + `?select=id,created_at,updated_at`
      + `&status=eq.active`
      + `&order=created_at.desc`
      + `&limit=${limit}&offset=${offset}`;

    const res = await fetch(url, { headers: supaHeaders() });
    if (!res.ok) break;

    const batch = await res.json();
    if (!batch || !batch.length) break;

    films.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return films;
}

function buildSitemap(films) {
  const today = new Date().toISOString().slice(0, 10);

  const staticUrls = STATIC_PAGES.map(p => `
  <url>
    <loc>${SITE_URL}${p.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('');

  const filmUrls = films.map(f => `
  <url>
    <loc>${SITE_URL}/watch.html?id=${escXml(f.id)}</loc>
    <lastmod>${toISODate(f.updated_at || f.created_at)}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9
        http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">

  <!--
    MOVXIO Sitemap — auto-generated ${new Date().toISOString()}
    Static: ${STATIC_PAGES.length} | Films: ${films.length} | Total: ${STATIC_PAGES.length + films.length}
  -->
${staticUrls}
${filmUrls}
</urlset>`;
}

async function handleSitemap() {
  try {
    const films = await fetchAllFilms();
    const xml   = buildSitemap(films);
    return new Response(xml, {
      status: 200,
      headers: {
        'Content-Type':  'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
        'X-Films-Count': String(films.length),
      },
    });
  } catch {
    // Never return 500 to Googlebot — serve minimal valid sitemap
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE_URL}/</loc><priority>1.0</priority></url>
</urlset>`,
      { status: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8' } }
    );
  }
}

// ─────────────────────────────────────────────────────────────
// ROUTE 2 — DYNAMIC OG META FOR WATCH PAGE
// ─────────────────────────────────────────────────────────────
const CRAWLER_UA = [
  'facebookexternalhit', 'twitterbot', 'whatsapp', 'telegrambot',
  'linkedinbot', 'slackbot', 'discordbot', 'googlebot', 'bingbot',
  'applebot', 'pinterest', 'vkshare', 'ia_archiver', 'bytespider',
];

function isCrawler(ua) {
  if (!ua) return false;
  const u = ua.toLowerCase();
  return CRAWLER_UA.some(p => u.includes(p));
}

async function fetchFilm(id) {
  const url = `${SUPABASE_URL}/rest/v1/films`
    + `?id=eq.${encodeURIComponent(id)}`
    + `&select=id,title,description,thumbnail_url,genre,year,imdb_rating`
    + `&limit=1`;
  const res = await fetch(url, { headers: supaHeaders() });
  if (!res.ok) return null;
  const data = await res.json();
  return data && data.length ? data[0] : null;
}

// HTMLRewriter handler — rewrites OG/Twitter meta tags in place
class OGRewriter {
  constructor(film) {
    const title  = film.title || SITE_NAME;
    const year   = film.year  ? ` (${film.year})` : '';
    const rating = film.imdb_rating ? ` · ★${film.imdb_rating}` : '';
    const genre  = film.genre ? film.genre.split(',')[0].trim() : '';
    const desc   = film.description
      ? film.description.slice(0, 160)
      : `Watch ${title} free on ${SITE_NAME} — no account needed.`;
    const image  = film.thumbnail_url || DEFAULT_IMG;
    const watchUrl = `${SITE_URL}/watch.html?id=${film.id}`;

    this.data = {
      pageTitle:      `${title}${year} — Watch Free on ${SITE_NAME}`,
      description:    desc,
      'og:title':     `${title}${year} — ${SITE_NAME}`,
      'og:description': desc,
      'og:image':     image,
      'og:image:width':  '600',
      'og:image:height': '900',
      'og:image:alt': `${title} poster`,
      'og:url':       watchUrl,
      'og:type':      'video.movie',
      'og:site_name': SITE_NAME,
      'twitter:card':        'summary_large_image',
      'twitter:title':       `${title}${year}${rating}`,
      'twitter:description': desc,
      'twitter:image':       image,
      'twitter:image:alt':   `${title} poster`,
      canonical:      watchUrl,
      keywords:       `${title}, watch free, ${genre}, ${SITE_NAME}, free movies`,
    };
  }

  element(el) {
    const tag  = el.tagName.toLowerCase();
    const d    = this.data;

    if (tag === 'title') {
      el.setInnerContent(d.pageTitle);
      return;
    }

    if (tag === 'meta') {
      const name = el.getAttribute('name')     || '';
      const prop = el.getAttribute('property') || '';

      if (name === 'description')           el.setAttribute('content', d.description);
      if (name === 'keywords')              el.setAttribute('content', d.keywords);
      if (name === 'twitter:card')          el.setAttribute('content', d['twitter:card']);
      if (name === 'twitter:title')         el.setAttribute('content', d['twitter:title']);
      if (name === 'twitter:description')   el.setAttribute('content', d['twitter:description']);
      if (name === 'twitter:image')         el.setAttribute('content', d['twitter:image']);
      if (name === 'twitter:image:alt')     el.setAttribute('content', d['twitter:image:alt']);

      if (prop === 'og:title')              el.setAttribute('content', d['og:title']);
      if (prop === 'og:description')        el.setAttribute('content', d['og:description']);
      if (prop === 'og:image')              el.setAttribute('content', d['og:image']);
      if (prop === 'og:image:width')        el.setAttribute('content', d['og:image:width']);
      if (prop === 'og:image:height')       el.setAttribute('content', d['og:image:height']);
      if (prop === 'og:image:alt')          el.setAttribute('content', d['og:image:alt']);
      if (prop === 'og:url')                el.setAttribute('content', d['og:url']);
      if (prop === 'og:type')               el.setAttribute('content', d['og:type']);
      if (prop === 'og:site_name')          el.setAttribute('content', d['og:site_name']);
    }

    if (tag === 'link' && el.getAttribute('rel') === 'canonical') {
      el.setAttribute('href', d.canonical);
    }
  }
}

async function handleWatchOG(request, filmId) {
  // Fetch film + original page in parallel
  const [film, page] = await Promise.all([
    fetchFilm(filmId).catch(() => null),
    fetch(request),
  ]);

  // No film or page error → serve original unchanged
  if (!film || !page.ok) return page;

  const rewriter = new OGRewriter(film);
  return new HTMLRewriter()
    .on('title',                     rewriter)
    .on('meta[name]',                rewriter)
    .on('meta[property]',            rewriter)
    .on('link[rel="canonical"]',     rewriter)
    .transform(page);
}

// ─────────────────────────────────────────────────────────────
// MAIN ROUTER
// ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url      = new URL(request.url);
    const path     = url.pathname;
    const method   = request.method;

    // ── Route 1: Sitemap ──────────────────────────────────────
    if (path === '/sitemap.xml' && method === 'GET') {
      return handleSitemap();
    }

    // ── Route 2: Watch page OG meta (crawlers only) ───────────
    const isWatch = path === '/watch.html' || path === '/watch' || path === '/watch/';
    if (isWatch && method === 'GET') {
      const filmId = url.searchParams.get('id');
      const ua     = request.headers.get('user-agent') || '';

      // Only intercept crawlers — regular users get page instantly
      if (filmId && isCrawler(ua)) {
        return handleWatchOG(request, filmId);
      }
    }

    // ── Everything else: pass through untouched ───────────────
    return fetch(request);
  },
};
