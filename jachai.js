/**
 * eslint-disable no-console
 *
 * @format
 */

const puppeteer = require("puppeteer");
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
const path = require("path");

// -------- Config --------
const START_PAGE = 1; // set to 2 if you want to start from /page/2
const MAX_PAGES = 500; // safety cap
const BASE = (n) => `https://www.jachai.org/fact-checks/page/${n}`;
const TIMEOUT = 45000;
const NAV_WAIT = { waitUntil: "domcontentloaded", timeout: TIMEOUT };
const POLITE_DELAY_MS = 400; // small delay between requests

// -------- Output paths (in ./data) --------
const DATA_DIR = path.resolve(__dirname, "data");
const OUT_CSV = path.join(DATA_DIR, "jachai_import.csv");
const OUT_JSONL = path.join(DATA_DIR, "jachai_import.jsonl");

// -------- Helpers --------
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

function getArticleIdFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/post-(\d+)/);
    if (m) return m[1];
  } catch {}
  return sha1(url);
}
function hostnamePretty(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
function categoryFromSlug(categoryHref) {
  if (!categoryHref) return null;
  try {
    const u = new URL(categoryHref);
    const segs = u.pathname.split("/").filter(Boolean);
    return segs[segs.length - 1] || null;
  } catch {
    return null;
  }
}
// Normalize any valid datetime to ISO8601 UTC (e.g., "2023-08-22T14:38:19.000Z")
function normalizeDateISO(dt) {
  if (!dt) return null;
  const d = new Date(dt);
  return isNaN(d) ? null : d.toISOString();
}
function csvEscape(s) {
  if (s === null || s === undefined) return "";
  const str = String(s);
  return /[,"\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

async function ensureOutputs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  // CSV with UTF-8 BOM so Excel renders Bangla correctly
  if (!fs.existsSync(OUT_CSV)) {
    await fsp.writeFile(
      OUT_CSV,
      "\uFEFF" +
        "article_id,publisher,source,category,published_at,headline,content,label\n",
      "utf8"
    );
  }
  if (fs.existsSync(OUT_JSONL)) await fsp.unlink(OUT_JSONL);
}

function appendRow(row) {
  const line =
    [
      csvEscape(row.article_id),
      csvEscape(row.publisher),
      csvEscape(row.source),
      csvEscape(row.category),
      csvEscape(row.published_at),
      csvEscape(row.headline),
      csvEscape(row.content),
      row.label,
    ].join(",") + "\n";
  fs.appendFileSync(OUT_CSV, line, "utf8");
  fs.appendFileSync(OUT_JSONL, JSON.stringify(row) + "\n", "utf8");
}

// Parse listing page for card-level fields
async function scrapeListPage(listPage) {
  return await listPage.$$eval("article.list-view", (nodes) => {
    return nodes
      .map((el) => {
        const titleA = el.querySelector("header.entry-header h2.entry-title a");
        const catA = el.querySelector("header.entry-header .entry-category a");
        const dateMeta = el.querySelector(
          "header.entry-header meta[itemprop='datePublished']"
        );
        return {
          url: titleA ? titleA.href : null,
          headline: titleA ? (titleA.textContent || "").trim() : null,
          categoryHref: catA ? catA.href : null,
          published_at_raw: dateMeta ? dateMeta.getAttribute("content") : null,
        };
      })
      .filter((x) => x.url && x.headline);
  });
}

// Visit article page and get <section class="entry-body"> text
async function fetchArticleContent(browser, url) {
  const p = await browser.newPage();
  try {
    await p.setExtraHTTPHeaders({ "Accept-Language": "bn,en;q=0.9" });
    await p.goto(url, NAV_WAIT);
    await p
      .waitForSelector("section.entry-body", { timeout: 5000 })
      .catch(() => {});
    const text = await p
      .$eval("section.entry-body", (el) => {
        const t = (el.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
        return t;
      })
      .catch(() => null);
    return text;
  } finally {
    await p.close().catch(() => {});
  }
}

// -------- Main --------
(async () => {
  await ensureOutputs();

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "bn,en;q=0.9" });

  let total = 0;

  for (let pnum = START_PAGE; pnum <= MAX_PAGES; pnum++) {
    const listUrl = BASE(pnum);
    console.log(`[list] ${listUrl}`);

    try {
      const res = await page.goto(listUrl, NAV_WAIT);
      const status = res?.status() || 0;
      if (status >= 400) {
        console.log(`  -> HTTP ${status}; stopping.`);
        break;
      }

      const hasArticles = await page.$$("article.list-view");
      if (!hasArticles || hasArticles.length === 0) {
        console.log("  -> no articles; stopping.");
        break;
      }

      const items = await scrapeListPage(page);
      console.log(`  -> found ${items.length} items`);

      for (const it of items) {
        const article_id = getArticleIdFromUrl(it.url);
        const publisher = hostnamePretty(it.url);
        const source = it.url;
        const category = categoryFromSlug(it.categoryHref);
        const published_at = normalizeDateISO(it.published_at_raw);
        const headline = it.headline;

        await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
        const content = await fetchArticleContent(browser, it.url); // may be null

        const row = {
          article_id,
          publisher,
          source,
          category,
          published_at, // normalized ISO UTC
          headline,
          content: content ?? null,
          label: 0, // all fake in this section
        };

        appendRow(row);
        total++;
      }

      console.log(`  -> saved ${items.length}; total ${total}`);
      await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
    } catch (err) {
      console.warn(`  !! failed on ${listUrl}: ${String(err).slice(0, 180)}`);
      break;
    }
  }

  await browser.close();
  console.log(`Done. Total rows: ${total}`);
})();
