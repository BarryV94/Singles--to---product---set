// build-western.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BASE_PATH = path.resolve("baza.json.gz");
const ROOT_EN_DIR = path.resolve("en");
const BASE_URL = "https://api.tcgdex.net/v2/en/cards";
const RATE_LIMIT_DELAY = 0;
const MAX_FILES_PER_SUBFOLDER = 999;
const CONCURRENCY = 40;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchCardDetails(cardId) {
  if (!cardId) return null;
  try {
    const tcgdex = require('tcgdex');
    if (tcgdex && tcgdex.card && typeof tcgdex.card.get === 'function') {
      try {
        const resp = await tcgdex.card.get(cardId);
        if (resp && typeof resp === 'object' && 'data' in resp) return resp.data;
        return resp ?? null;
      } catch (err) {
        console.warn(`tcgdex.client failed for id=${cardId}: ${err && err.message ? err.message : err}`);
      }
    }
  } catch (e) {
    // ignore: tcgdex package not available — fall back to fetch
  }

  const hasPercentEncoding = /%[0-9A-Fa-f]{2}/.test(cardId);
  const safeId = hasPercentEncoding ? cardId : encodeURIComponent(cardId);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/${safeId}`);
      if (res.ok) {
        try {
          return await res.json();
        } catch {
          return null;
        }
      }
      if (res.status === 400 || res.status === 404) {
        return null;
      }
      if (res.status >= 429) {
        await sleep(300 * attempt);
        continue;
      }
      return null;
    } catch {
      await sleep(300 * attempt);
    }
  }
  return null;
}

function saveDatedWesternFile(content) {
  fs.mkdirSync(ROOT_EN_DIR, { recursive: true });
  let idx = 1;
  let targetFolder = null;
  while (true) {
    const folderPath = path.join(ROOT_EN_DIR, String(idx));
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
      targetFolder = folderPath;
      break;
    }
    const entries = fs.readdirSync(folderPath);
    let fileCount = 0;
    for (const e of entries) {
      try {
        const st = fs.statSync(path.join(folderPath, e));
        if (st.isFile()) fileCount++;
      } catch (err) {}
    }
    if (fileCount < MAX_FILES_PER_SUBFOLDER) {
      targetFolder = folderPath;
      break;
    }
    idx++;
  }
  const now = new Date();
  const dateStrDots = new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(now);
  const dateStr = dateStrDots.replace(/\./g, "_");
  const fileName = `western_${dateStr}.json.gz`;
  const filePath = path.join(targetFolder, fileName);
  const json = JSON.stringify(content, null, 2);
  const gz = zlib.gzipSync(Buffer.from(json, "utf8"));
  fs.writeFileSync(filePath, gz);
  console.log(`✅ Saved dated western file: ${filePath}`);
}

function asyncPool(poolLimit, array, iteratorFn) {
  let i = 0;
  const ret = [];
  const executing = [];
  const enqueue = () => {
    if (i === array.length) return Promise.resolve();
    const item = array[i++];
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);
    const e = p.then(() => {
      const idx = executing.indexOf(e);
      if (idx > -1) executing.splice(idx, 1);
    }).catch(() => {
      const idx = executing.indexOf(e);
      if (idx > -1) executing.splice(idx, 1);
    });
    executing.push(e);
    let r = Promise.resolve();
    if (executing.length >= poolLimit) r = Promise.race(executing);
    return r.then(() => enqueue());
  };
  return enqueue().then(() => Promise.all(ret));
}

/**
 * Transform full detail object into minimal object the user requested:
 * {
 *   name,
 *   image,
 *   id,
 *   set: { id, name },
 *   cardmarket: { ... } (pricing.cardmarket or {})
 *   tcgplayer: { ... } (pricing.tcgplayer or {})
 * }
 *
 * Rules implemented:
 * - If pricing.cardmarket.idProduct exists, use it as top-level id (number). Otherwise fall back to originalId (cel25-1 etc).
 * - image: if present as string -> append "/high.webp" (only once). If array -> map each and append. If absent -> null.
 */
function transformDetails(details, originalId) {
  if (!details || typeof details !== 'object') return null;

  // get cardmarket and tcgplayer pricing objects (may be undefined)
  const pricing = details.pricing || {};
  const cardmarket = pricing.cardmarket || {};
  const tcgplayer = pricing.tcgplayer || {};

  // determine top-level id: prefer cardmarket.idProduct if available
  let topId = null;
  if (cardmarket && (cardmarket.idProduct || cardmarket.idProduct === 0)) {
    topId = cardmarket.idProduct;
  } else if (details.id) {
    topId = details.id;
  } else {
    topId = originalId || null;
  }

  // normalize image(s) and append "/high.webp" when appropriate
  const appendHigh = (img) => {
    if (!img) return null;
    if (typeof img !== 'string') return null;
    // avoid double-appending if already ends with "/high.webp"
    if (img.endsWith('/high.webp')) return img;
    // remove trailing slashes
    let trimmed = img.replace(/\/+$/, '');
    return `${trimmed}/high.webp`;
  };

  let imageField = null;
  if (Array.isArray(details.image)) {
    const mapped = details.image.map(appendHigh).filter(Boolean);
    imageField = mapped.length ? mapped : null;
  } else if (typeof details.image === 'string') {
    imageField = appendHigh(details.image);
  } else if (details.image && typeof details.image === 'object' && details.image.small) {
    // if image is an object with urls, prefer a sensible one
    imageField = appendHigh(details.image.small) || appendHigh(details.image.large) || null;
  } else {
    imageField = null;
  }

  const out = {
    name: details.name ?? null,
    image: imageField,
    id: topId,
    set: {
      id: details.set && details.set.id ? details.set.id : null,
      name: details.set && details.set.name ? details.set.name : null
    },
    cardmarket: cardmarket,
    tcgplayer: tcgplayer
  };

  return out;
}

async function main() {
  try {
    console.log("📦 Loading baza.json.gz...");
    if (!fs.existsSync(BASE_PATH)) {
      console.error(`Brak pliku bazowego: ${BASE_PATH}. Upewnij się, że uruchomiłeś fetch-baza.js.`);
      process.exit(1);
    }
    const gzBuf = fs.readFileSync(BASE_PATH);
    const jsonBuf = zlib.gunzipSync(gzBuf);
    const baseCards = JSON.parse(jsonBuf.toString("utf8"));
    if (!Array.isArray(baseCards)) {
      throw new Error("Invalid base response format (expected array)");
    }
    console.log(`🔧 Building dated western file from ${baseCards.length} base entries...`);
    const ids = baseCards.map(b => b.id);
    let processed = 0;
    const results = await asyncPool(CONCURRENCY, ids, async (id) => {
      const details = await fetchCardDetails(id);
      processed++;
      if (processed % 500 === 0) console.log(`✔ processed ${processed}/${ids.length}`);
      if (RATE_LIMIT_DELAY) await sleep(RATE_LIMIT_DELAY);
      if (details) {
        return transformDetails(details, id);
      }
      console.warn(`⚠️ Missing details for id=${id} (skipping)`);
      return null;
    });
    const western = results.filter(Boolean);
    console.log(`✅ DONE – collected ${western.length} simplified card entries. Now saving dated file...`);
    try {
      saveDatedWesternFile(western);
    } catch (err) {
      console.error("⚠️ Failed to save dated EN file:", err);
    }
  } catch (err) {
    console.error("💥 Fatal error:", err);
    process.exit(1);
  }
}

main();
