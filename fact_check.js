/** @format */

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const CATEGORY_BASE =
  "https://www.fact-watch.org/category/%E0%A6%AB%E0%A7%8D%E0%A6%AF%E0%A6%BE%E0%A6%95%E0%A7%8D%E0%A6%9F%E0%A6%9A%E0%A7%87%E0%A6%95";
const FIRST_PAGE = 1;
const LAST_PAGE = 70;

const OUT_DIR = path.join(__dirname, "data");
const JSONL_PATH = path.join(OUT_DIR, "factwatch_factchecks.jsonl");
const CSV_PATH = path.join(OUT_DIR, "factwatch_factchecks.csv");

// Timing / politeness
const NAV_TIMEOUT_MS = 45000;
const LINK_DELAY_MS = 600; // small politeness delay when launching tabs
const EXTRA_JITTER_MS = 400;
const CONCURRENCY_PER_PAGE = 12; // up to 12 cards per page

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function jitter(ms) {
  return ms + Math.floor(Math.random() * EXTRA_JITTER_MS);
}

function toCsvField(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).replace(/\r?\n/g, " ").trim();
  if (s.includes('"') || s.includes(",")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// article_id = URL slug (last non-empty segment)
function slugFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || "";
  } catch {
    return "";
  }
}

function ensureOut() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(JSONL_PATH)) fs.writeFileSync(JSONL_PATH, "", "utf8");
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(
      CSV_PATH,
      "article_id,publisher,source,category,published_at,headline,content,label\n",
      "utf8"
    );
  }
}

function writeRecord(rec) {
  fs.appendFileSync(JSONL_PATH, JSON.stringify(rec) + "\n", "utf8");
  const line =
    [
      rec.article_id,
      rec.publisher,
      rec.source,
      rec.category,
      rec.published_at,
      rec.headline,
      rec.content ?? "",
      rec.label,
    ]
      .map(toCsvField)
      .join(",") + "\n";
  fs.appendFileSync(CSV_PATH, line, "utf8");
}

async function collectCardUrlsOnList(page) {
  // wait for the grid to appear
  await page.waitForSelector(".category-more-blogs .more-wrapper", {
    timeout: 20000,
  });

  // Each card contains a title link: h3.title > a[href]
  const urls = await page.$$eval(
    ".category-more-blogs .more-wrapper .card h3.title a[href]",
    (as) => {
      const seen = new Set();
      const out = [];
      for (const a of as) {
        const href = a.getAttribute("href");
        if (!href) continue;
        try {
          const abs = new URL(href, location.origin).href;
          if (!seen.has(abs)) {
            seen.add(abs);
            out.push(abs);
          }
        } catch (_) {}
      }
      return out;
    }
  );
  return urls;
}

async function scrapeSinglePost(browser, url) {
  const p = await browser.newPage();
  p.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  try {
    await p.setExtraHTTPHeaders({ "Accept-Language": "bn,en;q=0.9" });
    await p.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    );

    await p.goto(url, { waitUntil: "domcontentloaded" });

    // Check existence of .factcheck-schema; extract schema text for label + fields
    const hasSchema = await p.$(".factcheck-schema");
    if (!hasSchema) {
      // Skip when schema is absent
      return null;
    }

    const data = await p.evaluate(() => {
      // headline
      const h1 =
        document.querySelector(".single-post-header h1") ||
        document.querySelector("h1");

      const headline = (h1?.textContent || "").trim();

      // published_at
      const dateEl = document.querySelector(
        ".single-post-meta .date, .single-post-header .single-post-meta .date"
      );
      const published_at = (dateEl?.textContent || "").trim();

      // factcheck schema block (for label; and we will exclude it from content)
      const schemaEl = document.querySelector(".factcheck-schema");
      const schemaText = (schemaEl?.innerText || "").toLowerCase();

      // main content: section.fw-content (remove schema block if inside)
      const contentRoot = document.querySelector("section.fw-content");
      let content = "";
      if (contentRoot) {
        // clone and strip schema block
        const clone = contentRoot.cloneNode(true);
        const bad = clone.querySelector(".factcheck-schema");
        if (bad) bad.remove();
        content = (clone.innerText || clone.textContent || "")
          .replace(/\n{2,}/g, "\n")
          .replace(/\s+\n/g, "\n")
          .replace(/\n\s+/g, "\n")
          .trim();
      }

      return { headline, published_at, content, schemaText };
    });

    if (!data) return null;

    const label = /false/i.test(data.schemaText) ? 0 : 1; // 1 if "false" appears

    return {
      article_id: slugFromUrl(url),
      publisher: "fact-watch",
      source: url,
      category: "fact-check",
      published_at: data.published_at,
      headline: data.headline,
      content: data.content || null,
      label,
    };
  } catch (e) {
    console.warn("Post failed:", url, e.message);
    return null;
  } finally {
    await p.close();
  }
}

async function scrapeListPage(browser, pageNum) {
  const url =
    pageNum === 1 ? CATEGORY_BASE + "/" : `${CATEGORY_BASE}/page/${pageNum}/`;
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "bn,en;q=0.9" });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    );
    console.log("Opening list:", url);
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const postUrls = await collectCardUrlsOnList(page);
    if (postUrls.length === 0) {
      console.log("No cards found on", url);
      return 0;
    }

    // Scrape concurrently (cap at 12 per page)
    const tasks = postUrls.map(async (u, i) => {
      await sleep(jitter(LINK_DELAY_MS * (i % CONCURRENCY_PER_PAGE)));
      return scrapeSinglePost(browser, u);
    });

    const results = await Promise.all(tasks);
    let saved = 0;
    for (const rec of results) {
      if (!rec) continue;
      writeRecord(rec);
      saved++;
      console.log(
        `Saved [${rec.article_id}] ${
          rec.headline?.slice(0, 70) || "(no title)"
        }`
      );
    }
    return saved;
  } catch (e) {
    console.warn("List failed:", url, e.message);
    return 0;
  } finally {
    await page.close();
  }
}

async function main() {
  ensureOut();

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
    defaultViewport: { width: 1366, height: 900 },
  });

  let total = 0;
  for (let p = FIRST_PAGE; p <= LAST_PAGE; p++) {
    const saved = await scrapeListPage(browser, p);
    total += saved;
    console.log(`Page ${p} → saved ${saved} (running total ${total})`);
  }

  console.log("Done. Total saved:", total);
  console.log("JSONL:", JSONL_PATH);
  console.log("CSV  :", CSV_PATH);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
