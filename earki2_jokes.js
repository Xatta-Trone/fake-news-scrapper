/** @format */

// Usage:
//   npm init -y
//   npm i puppeteer
//   node earki_jokes_scraper.js

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const START_URL = "https://www.earki.co/jokes";
const BASE = "https://www.earki.co";

// Output
const OUT_DIR = path.join(__dirname, "data");
const JSONL_PATH = path.join(OUT_DIR, "earki_jokes.jsonl");
const CSV_PATH = path.join(OUT_DIR, "earki_jokes.csv");

// Timing (politeness & stability)
const CLICK_INTERVAL_MS = 5000; // time to wait after each "Load More" click
const LINK_DELAY_MS = 1200; // delay between visiting article links
const EXTRA_JITTER_MS = 600; // small random jitter added to waits
const NAV_TIMEOUT_MS = 45000; // navigation timeout
const MAX_CLICKS = 100000; // safety cap for "Load More" clicks
const MAX_ARTICLES = Infinity; // set a number to cap scraping early

// Helpers
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

// Extract numeric ID from jokes article URL like /jokes/joke/11081/...
function getArticleIdFromUrl(url) {
  const m = String(url).match(/\/jokes\/joke\/(\d+)(?:\/|$)/);
  return m ? m[1] : null;
}

async function ensureOut() {
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

/**
 * Return [{ url, id }] from the current list page.
 * De-duped, absolute URLs, in on-page order.
 */
async function collectLinkObjs(page) {
  // Ensure some cards exist
  await page.waitForSelector(".single_stream_content .each", {
    timeout: 15000,
  });

  const urls = await page.$$eval(
    '.single_stream_content .each a[href^="/jokes/joke"]',
    (anchors) => {
      const seen = new Set();
      const out = [];
      for (const a of anchors) {
        const href = a.getAttribute("href");
        if (!href) continue;
        const abs = new URL(href, location.origin).href;
        if (!seen.has(abs)) {
          seen.add(abs);
          out.push(abs);
        }
      }
      return out;
    }
  );

  return urls.map((url) => ({ url, id: getArticleIdFromUrl(url) || "" }));
}

function buildRecord({ url, published_at, headline, content }) {
  return {
    article_id: getArticleIdFromUrl(url) || "",
    publisher: "earki",
    source: url,
    category: "jokes",
    published_at: published_at || "",
    headline: headline || "",
    content: content === null ? null : content,
    label: 0,
  };
}

function writeRecord(record) {
  // JSONL
  fs.appendFileSync(JSONL_PATH, JSON.stringify(record) + "\n", "utf8");
  // CSV
  const csvLine =
    [
      record.article_id,
      record.publisher,
      record.source,
      record.category,
      record.published_at,
      record.headline,
      record.content === null ? "" : record.content,
      record.label,
    ]
      .map(toCsvField)
      .join(",") + "\n";
  fs.appendFileSync(CSV_PATH, csvLine, "utf8");
}

async function scrapeOneArticle(browser, url) {
  const p = await browser.newPage();
  p.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  try {
    await p.setExtraHTTPHeaders({ "Accept-Language": "bn,en;q=0.9" });
    await p.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    );

    await p.goto(url, { waitUntil: "domcontentloaded" });

    const row = await p.evaluate(() => {
      // Title candidates
      const titleEl =
        document.querySelector("h1.title .title") ||
        document.querySelector("h2.title .title") ||
        document.querySelector("h1 .title") ||
        document.querySelector("h2 .title") ||
        document.querySelector("meta[property='og:title']");

      const headline = titleEl
        ? (titleEl.content || titleEl.textContent || "").trim()
        : null;

      // Publish time candidates
      const timeEl =
        document.querySelector("span.time") ||
        document.querySelector("time[datetime]") ||
        document.querySelector("meta[property='article:published_time']");

      const publishedAttr =
        timeEl?.getAttribute?.("data-published") ||
        timeEl?.getAttribute?.("datetime") ||
        timeEl?.getAttribute?.("content") ||
        "";

      // Body
      const bodyEl =
        document.querySelector('div[itemprop="articleBody"]') ||
        document.querySelector('article [itemprop="articleBody"]') ||
        document.querySelector("article .content") ||
        document.querySelector(".article_body") ||
        document.querySelector(".content");

      let content = null;
      if (bodyEl) {
        content = (bodyEl.innerText || bodyEl.textContent || "")
          .replace(/\n{2,}/g, "\n")
          .replace(/\s+\n/g, "\n")
          .replace(/\n\s+/g, "\n")
          .trim();
        if (!content) content = null;
      }

      return { headline, published_at: publishedAttr || "", content };
    });

    return buildRecord({ url, ...row });
  } catch (err) {
    console.warn("Failed:", url, err.message);
    return null;
  } finally {
    await p.close();
  }
}

async function main() {
  await ensureOut();

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
    defaultViewport: { width: 1366, height: 900 },
  });

  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  await page.setExtraHTTPHeaders({ "Accept-Language": "bn,en;q=0.9" });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
  );

  console.log("Opening list:", START_URL);
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });

  // track what we've saved
  const seenIds = new Set();
  let totalSaved = 0;
  let clicks = 0;

  // Helper: process any *new* cards currently on the list page
  async function processNewCardsOnList() {
    const linkObjs = await collectLinkObjs(page);
    // filter unseen
    const newOnes = linkObjs.filter(({ id }) => id && !seenIds.has(id));
    if (newOnes.length === 0) return 0;

    let savedNow = 0;
    for (const { url, id } of newOnes) {
      if (MAX_ARTICLES !== Infinity && totalSaved >= MAX_ARTICLES) break;
      await sleep(jitter(LINK_DELAY_MS)); // polite delay
      const rec = await scrapeOneArticle(browser, url);
      if (rec) {
        writeRecord(rec);
        seenIds.add(id);
        totalSaved += 1;
        savedNow += 1;
        console.log(
          `Saved #${rec.article_id} (${totalSaved} total): ${
            rec.headline?.slice(0, 70) || "(no title)"
          }`
        );
      }
    }
    return savedNow;
  }

  // Check if the site already says "আর নেই" (button text preferred)
  function noMoreCheck() {
    return () => {
      const btn = document.querySelector(".ajax_load_btn");
      const btnText = btn ? (btn.textContent || "").trim() : "";
      // Some sites flip text or hide button when exhausted; keep this simple check
      return btnText.includes("আর নেই");
    };
  }

  // 1) Process the initially loaded items
  await processNewCardsOnList();

  // 2) Keep clicking load more; after each click, process newly added cards immediately
  while (true) {
    // If no more indicated, stop
    const done = await page.evaluate(noMoreCheck());
    if (done) {
      console.log('Found "আর নেই" on the button. Stop clicking.');
      break;
    }

    // Check button presence/visibility
    const state = await page.evaluate(() => {
      const btn = document.querySelector("button.ajax_load_btn");
      if (!btn) return { exists: false, visible: false, text: "" };
      const style = window.getComputedStyle(btn);
      const visible =
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        !btn.hasAttribute("disabled");
      return { exists: true, visible, text: (btn.textContent || "").trim() };
    });

    if (!state.exists) {
      console.log("Load More button not found. Stop clicking.");
      break;
    }

    if (state.visible) {
      console.log(`Click ${clicks + 1}: Load More (text="${state.text}")`);
      try {
        await page.click("button.ajax_load_btn", { delay: 40 });
      } catch (e) {
        console.log("Click failed (ignored):", e.message);
      }

      // Wait for either "আর নেই" or usual delay to let new HTML append
      await Promise.race([
        page
          .waitForFunction(noMoreCheck(), {
            polling: 500,
            timeout: jitter(8000),
          })
          .catch(() => {}),
        sleep(jitter(CLICK_INTERVAL_MS)),
      ]);

      // >>> Incremental step: process any new cards just loaded
      await processNewCardsOnList();
    } else {
      // not visible yet—wait and re-check (e.g., while loading)
      await sleep(jitter(1500));
    }

    if (++clicks >= MAX_CLICKS) {
      console.log("Hit MAX_CLICKS safety cap. Stopping.");
      break;
    }

    if (MAX_ARTICLES !== Infinity && totalSaved >= MAX_ARTICLES) {
      console.log(`Reached MAX_ARTICLES=${MAX_ARTICLES}. Stopping.`);
      break;
    }
  }

  console.log(`Done. Articles saved: ${totalSaved}`);
  console.log("JSONL:", JSONL_PATH);
  console.log("CSV  :", CSV_PATH);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
