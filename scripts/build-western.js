// build-western.js
// Automatic conversion: this script builds dated western_*.json.gz (new data)
// and then AUTOMATICALLY scans en/*/*.json.gz and converts any legacy full entries
// into the new minimal format, OVERWRITING them WITHOUT CREATING BACKUPS.

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

/* --------------------------
   transformDetails -> minimal
   -------------------------- */
function transformDetails(details, originalId) {
  if (!details || typeof details !== 'object') return null;

  const pricing = details.pricing || {};
  const cardmarket = pricing.cardmarket || {};
  const tcgplayer = pricing.tcgplayer || {};

  // choose top-level id: cardmarket.idProduct if present; else details.id; else originalId
  let topId = null;
  if (cardmarket && (cardmarket.idProduct || cardmarket.idProduct === 0)) {
    topId = cardmarket.idProduct;
  } else if (details.id) {
    topId = details.id;
  } else {
    topId = originalId || null;
  }

  const appendHigh = (img) => {
    if (!img || typeof img !== 'string') return null;
    if (img.endsWith('/high.webp')) return img;
    let trimmed = img.replace(/\/+$/, '');
    return `${trimmed}/high.webp`;
  };

  let imageField = null;
  if (Array.isArray(details.image)) {
    const mapped = details.image.map(appendHigh).filter(Boolean);
    imageField = mapped.length ? mapped : null;
  } else if (typeof details.image === 'string') {
    imageField = appendHigh(details.image);
  } else if (details.image && typeof details.image === 'object' && (details.image.small || details.image.large)) {
    imageField = appendHigh(details.image.small) || appendHigh(details.image.large) || null;
  } else {
    imageField = null;
  }

  return {
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
}

/* --------------------------
   save dated file
   -------------------------- */
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

/* --------------------------
   asyncPool
   -------------------------- */
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

/* --------------------------
   Conversion helpers
   -------------------------- */
function isGzFile(fn) {
  return fn.endsWith('.json.gz');
}

function walkDir(dir) {
  const res = [];
  if (!fs.existsSync(dir)) return res;
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    const st = fs.statSync(p);
    if (st.isDirectory()) res.push(...walkDir(p));
    else if (st.isFile() && isGzFile(p)) res.push(p);
  }
  return res;
}

function unzipJson(gzPath) {
  const buf = fs.readFileSync(gzPath);
  const jsonBuf = zlib.gunzipSync(buf);
  return JSON.parse(jsonBuf.toString('utf8'));
}

function gzipJson(obj) {
  const json = JSON.stringify(obj, null, 2);
  return zlib.gzipSync(Buffer.from(json, 'utf8'));
}

function looksLikeLegacyEntry(item) {
  if (!item || typeof item !== 'object') return false;
  if ('pricing' in item) return true;
  const legacyHints = ['attacks', 'hp', 'types', 'rarity', 'stage', 'retreat', 'dexId'];
  for (const h of legacyHints) if (h in item) return true;
  if ('cardmarket' in item || 'tcgplayer' in item) return false;
  return false;
}

/* convertSingleFile - overwrites without backup */
function convertSingleFile(filePath) {
  try {
    const parsed = unzipJson(filePath);
    let arr = null;
    if (Array.isArray(parsed)) arr = parsed;
    else if (parsed && Array.isArray(parsed.cards)) arr = parsed.cards;
    else {
      console.log(`  - Skipping ${filePath}: not an array and does not contain .cards array.`);
      return { skipped: true };
    }

    const someLegacy = arr.some(looksLikeLegacyEntry);
    if (!someLegacy) {
      console.log(`  - Skipping ${filePath}: already looks converted.`);
      return { skipped: true };
    }

    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (looksLikeLegacyEntry(item)) {
        const originalId = item.id || null;
        const t = transformDetails(item, originalId);
        if (t) out.push(t);
        else {
          console.warn(`    ✖ Item ${i} transform returned null -> skipping`);
        }
      } else {
        out.push(item);
      }
    }

    console.log(`  - Converting ${filePath} (${out.length}/${arr.length} items).`);

    const gz = gzipJson(out);
    fs.writeFileSync(filePath, gz);
    console.log(`    ✅ Converted and overwritten (no backup).`);
    return { converted: true };
  } catch (err) {
    console.error(`    💥 Error converting ${filePath}:`, err && err.stack ? err.stack : err);
    return { error: true };
  }
}

/* --------------------------
   Main flow (automatic conversion)
   -------------------------- */
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
      if (details) return transformDetails(details, id);
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

    // === AUTOMATIC: convert existing files under en/*/*.json.gz ===
    console.log('\n🔁 Automatic conversion: scanning all existing en/*/*.json.gz files...');
    const files = walkDir(ROOT_EN_DIR);
    console.log(`Found ${files.length} .json.gz files under ${ROOT_EN_DIR}`);

    for (const filePath of files) {
      console.log('➡️', filePath);
      try {
        convertSingleFile(filePath);
      } catch (e) {
        console.error('  💥 Error during convertSingleFile:', e && e.stack ? e.stack : e);
      }
    }

    console.log('\nConversion pass finished.');
    console.log('\nAll done.');
  } catch (err) {
    console.error("💥 Fatal error:", err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

main();
