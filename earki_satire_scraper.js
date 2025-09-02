/** @format */

// Usage:
//   npm init -y
//   npm i puppeteer
//   node earki_satire_scraper.js

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const START_URL = "https://www.earki.co/satire";
const BASE = "https://www.earki.co";

// Output
const OUT_DIR = path.join(__dirname, "data");
const JSONL_PATH = path.join(OUT_DIR, "earki_satire.jsonl");
const CSV_PATH = path.join(OUT_DIR, "earki_satire.csv");

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

async function collectAllLinks(page) {
  // dedupe via Set and expand relative -> absolute URLs
  const links = await page.evaluate((BASE) => {
    const set = new Set();
    document
      .querySelectorAll(
        '.content_group_inner .each.has_image a[href^="/satire/article"]'
      )
      .forEach((a) => {
        const href = a.getAttribute("href") || "";
        if (!href) return;
        const url = href.startsWith("http") ? href : BASE + href;
        set.add(url);
      });
    return Array.from(set);
  }, BASE);
  return links;
}

// >>> Extract numeric ID from satire article URL
function getArticleIdFromUrl(url) {
  // matches /satire/article/10872/anything
  const m = url.match(/\/satire\/article\/(\d+)\b/);
  return m ? m[1] : null;
}

async function main() {
  await ensureOut();

  const browser = await puppeteer.launch({
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
    defaultViewport: { width: 1366, height: 900 },
  });

  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  //   await page.setUserAgent(
  //     "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
  //   );
  await page.setExtraHTTPHeaders({ "Accept-Language": "bn,en;q=0.9" });

  console.log("Opening list:", START_URL);
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });

  // Keep clicking "Load More" until:
  // 1) the button disappears, OR
  // 2) "আর নেই" appears (prefer the button text, but also check anywhere in DOM)
  let clicks = 0;

  function noMoreCheck() {
    return () => {
      const btn =
        document.querySelector(".ajax_load_btn");
      const btnText = btn ? (btn.textContent || "").trim() : "";
      return btnText.includes("আর নেই");
    };

  }

  while (true) {
    // Fast pre-check before trying to click again
    const done = await page.evaluate(noMoreCheck());
    if (done) {
      console.log('Found "আর নেই" (button text or anywhere). Stop clicking.');
      break;
    }

    // Check button presence/visibility
    const state = await page.evaluate(() => {
      const btn =
        document.querySelector("button.ajax_load_btn");

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
        await page.click("button.ajax_load_btn", {
          delay: 40,
        });
      } catch {}

      // wait for either the "আর নেই" condition OR the usual delay
      await Promise.race([
        page
          .waitForFunction(noMoreCheck(), {
            polling: 500,
            timeout: jitter(8000),
          })
          .catch(() => {}),
        sleep(jitter(CLICK_INTERVAL_MS)),
      ]);
    } else {
      // not visible yet—wait and re-check
      await sleep(jitter(1500));
    }

    if (++clicks >= MAX_CLICKS) {
      console.log("Hit MAX_CLICKS safety cap. Stopping.");
      break;
    }
  }

  // Collect article links
  const links = await collectAllLinks(page);
  console.log(`Collected ${links.length} article URLs.`);

  let processed = 0;

  for (const url of links.slice(0, MAX_ARTICLES)) {
    await sleep(jitter(LINK_DELAY_MS)); // polite delay between articles

    const p = await browser.newPage();
    p.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    try {
      await p.goto(url, { waitUntil: "domcontentloaded" });

      // Extract fields
      const row = await p.evaluate(() => {
        // Headline is usually within h1.title .title (fallbacks added)
        const titleEl =
          document.querySelector("h1.title .title") ||
          document.querySelector("h2.title .title") ||
          document.querySelector("h1 .title") ||
          document.querySelector("h2 .title");

        const headline = titleEl ? titleEl.textContent.trim() : null;

        const timeEl = document.querySelector("span.time");
        const publishedAttr = timeEl
          ? timeEl.getAttribute("data-published")
          : null;

        const bodyEl = document.querySelector('div[itemprop="articleBody"]');
        let content = null;
        if (bodyEl) {
          content = bodyEl.innerText
            .replace(/\n{2,}/g, "\n")
            .replace(/\s+\n/g, "\n")
            .replace(/\n\s+/g, "\n")
            .trim();
          if (content.length === 0) content = null;
        }

        return {
          headline,
          published_at: publishedAttr || "",
          content,
        };
      });

      // >>> Use numeric article_id from URL
      const article_id = getArticleIdFromUrl(url) || "";

      const record = {
        article_id,
        publisher: "earki",
        source: url,
        category: "article",
        published_at: row.published_at,
        headline: row.headline || "",
        content: row.content === null ? null : row.content,
        label: 0,
      };

      // Append JSONL
      fs.appendFileSync(JSONL_PATH, JSON.stringify(record) + "\n", "utf8");

      // Append CSV
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

      processed += 1;
      console.log(
        `Saved ${processed}/${links.length}: ${
          record.headline?.slice(0, 70) || "(no title)"
        }`
      );
    } catch (err) {
      console.warn("Failed:", url, err.message);
    } finally {
      await p.close();
    }
  }

  console.log(`Done. Articles saved: ${processed}`);
  console.log("JSONL:", JSONL_PATH);
  console.log("CSV  :", CSV_PATH);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
