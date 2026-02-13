// build-western.js
// Updated: saves dated western_*.json.gz into en/<YEAR>/ (no numeric subfolders)
// Migration moves existing .json.gz files into en/<YEAR>/ without renaming (skips on conflict).
// Supports --dry-run to preview migration actions (does not move files when --dry-run present).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BASE_PATH = path.resolve("baza.json.gz");
const ROOT_EN_DIR = path.resolve("en");
const BASE_URL = "https://api.tcgdex.net/v2/en/cards";
const RATE_LIMIT_DELAY = 0;
const CONCURRENCY = 40;
const DRY_RUN = process.argv.includes('--dry-run');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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
        try { return await res.json(); } catch { return null; }
      }
      if (res.status === 400 || res.status === 404) return null;
      if (res.status >= 429) { await sleep(300 * attempt); continue; }
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

  let topId = null;
  if (cardmarket && (cardmarket.idProduct || cardmarket.idProduct === 0)) topId = cardmarket.idProduct;
  else if (details.id) topId = details.id;
  else topId = originalId || null;

  const appendHigh = (img) => {
    if (!img || typeof img !== 'string') return null;
    if (img.endsWith('/high.webp')) return img;
    const trimmed = img.replace(/\/+$/, '');
    return `${trimmed}/high.webp`;
  };

  let imageField = null;
  if (Array.isArray(details.image)) {
    const mapped = details.image.map(appendHigh).filter(Boolean);
    imageField = mapped.length ? mapped : null;
  } else if (typeof details.image === 'string') imageField = appendHigh(details.image);
  else if (details.image && typeof details.image === 'object') imageField = appendHigh(details.image.small) || appendHigh(details.image.large) || null;
  else imageField = null;

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
   gzip/unzip helpers
   -------------------------- */
function unzipJson(gzPath) {
  const buf = fs.readFileSync(gzPath);
  const jsonBuf = zlib.gunzipSync(buf);
  return JSON.parse(jsonBuf.toString('utf8'));
}
function gzipJson(obj) { return zlib.gzipSync(Buffer.from(JSON.stringify(obj, null, 2), 'utf8')); }

/* --------------------------
   walkDir: collect .json.gz files recursively
   -------------------------- */
function isGzFile(fn) { return fn.endsWith('.json.gz'); }
function walkDir(dir) {
  const res = [];
  if (!fs.existsSync(dir)) return res;
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) res.push(...walkDir(p));
    else if (st.isFile() && isGzFile(p)) res.push(p);
  }
  return res;
}

/* --------------------------
   Helpers for filesystem
   -------------------------- */
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function getYearFromFilenameOrMtime(filename, filePath) {
  const m = filename.match(/_(\d{4})\.json\.gz$/);
  if (m) return m[1];
  try { const st = fs.statSync(filePath); return String(new Date(st.mtime).getFullYear()); } catch { return String(new Date().getFullYear()); }
}

/* --------------------------
   save dated file into en/<YEAR>/
   uses Europe/Warsaw for date string and year
   -------------------------- */
function saveDatedWesternFile(content) {
  const now = new Date();
  // use Warsaw timezone for the date string and year
  const dateStrDots = new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(now);
  const dateStr = dateStrDots.replace(/\./g, "_");
  const fileName = `western_${dateStr}.json.gz`;

  const yearStr = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', year: 'numeric' }).format(now);
  const yearBase = path.join(ROOT_EN_DIR, yearStr);
  ensureDir(yearBase);
  const filePath = path.join(yearBase, fileName);
  if (fs.existsSync(filePath)) {
    // try to avoid accidental overwrite by adding timestamp suffix when *same exact name* exists
    const alt = fileName.replace(/\.json\.gz$/, `_${Date.now()}.json.gz`);
    const altPath = path.join(yearBase, alt);
    console.warn(`Target exists ${filePath} — writing as ${altPath}`);
    if (!DRY_RUN) fs.writeFileSync(altPath, gzipJson(content));
    console.log(`✅ Saved dated western file: ${DRY_RUN ? '[dry-run] ' : ''}${altPath}`);
    return altPath;
  }

  if (!DRY_RUN) fs.writeFileSync(filePath, gzipJson(content));
  console.log(`✅ Saved dated western file: ${DRY_RUN ? '[dry-run] ' : ''}${filePath}`);
  return filePath;
}

/* --------------------------
   Migration: move ALL .json.gz under en/... into en/<YEAR>/
   - Does NOT rename files. If target exists, skip and log.
   - If --dry-run is provided the actions are only printed.
   -------------------------- */
function migrateAllToYearFolders_NoRename() {
  if (!fs.existsSync(ROOT_EN_DIR)) return;
  const allFiles = walkDir(ROOT_EN_DIR);
  if (allFiles.length === 0) {
    console.log('🔁 No .json.gz files found to migrate under', ROOT_EN_DIR);
    return;
  }

  console.log(`🔁 Migrating ${allFiles.length} .json.gz files into en/<YEAR>/ (no renames)${DRY_RUN ? ' [dry-run]' : ''}...`);

  for (const filePath of allFiles) {
    const filename = path.basename(filePath);
    // Skip files that are already directly under a year root: en/<YYYY>/<filename>
    const rel = path.relative(ROOT_EN_DIR, filePath).split(path.sep);
    if (rel.length === 2 && /^\d{4}$/.test(rel[0])) {
      // already in en/<YEAR>/file.ext
      continue;
    }

    const year = getYearFromFilenameOrMtime(filename, filePath);
    const desiredDir = path.join(ROOT_EN_DIR, year);
    ensureDir(desiredDir);

    const targetPath = path.join(desiredDir, filename);
    if (path.resolve(path.dirname(filePath)) === path.resolve(desiredDir)) {
      continue; // already in correct folder
    }

    if (fs.existsSync(targetPath)) {
      console.log(`SKIP (target exists): ${filePath} -> ${targetPath}`);
      continue; // do not rename or overwrite
    }

    console.log(`${DRY_RUN ? '[DRY] ' : ''}Move: ${filePath} -> ${targetPath}`);
    if (!DRY_RUN) {
      try {
        fs.renameSync(filePath, targetPath);
      } catch (e) {
        // fallback copy+unlink across filesystems
        try {
          fs.copyFileSync(filePath, targetPath);
          fs.unlinkSync(filePath);
        } catch (err) {
          console.error(`  ✖ Failed to move ${filePath} -> ${targetPath}:`, err && err.message ? err.message : err);
        }
      }
    }
  }

  // Clean up empty directories except year roots
  function removeEmptyDirsRecursively(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      try {
        if (fs.statSync(full).isDirectory()) {
          removeEmptyDirsRecursively(full);
          const contents = fs.readdirSync(full);
          if (contents.length === 0) {
            // do not remove year roots (4-digit names) at this stage
            if (!/^\d{4}$/.test(path.basename(full))) {
              try { fs.rmdirSync(full); console.log(`  - Removed empty folder ${full}`); } catch (e) {}
            }
          }
        }
      } catch (e) {}
    }
  }

  // perform cleanup for non-year directories
  const topEntries = fs.readdirSync(ROOT_EN_DIR);
  for (const e of topEntries) {
    const full = path.join(ROOT_EN_DIR, e);
    try {
      if (fs.statSync(full).isDirectory() && !/^\d{4}$/.test(e)) {
        removeEmptyDirsRecursively(full);
        try {
          const after = fs.readdirSync(full);
          if (after.length === 0) {
            try { fs.rmdirSync(full); console.log(`  - Removed empty top folder ${full}`); } catch (e) {}
          }
        } catch (er) {}
      } else if (fs.statSync(full).isDirectory() && /^\d{4}$/.test(e)) {
        // remove nested empties inside year root
        removeEmptyDirsRecursively(full);
      }
    } catch (err) {}
  }
}

/* --------------------------
   asyncPool
   -------------------------- */
function asyncPool(poolLimit, array, iteratorFn) {
  let i = 0; const ret = []; const executing = [];
  const enqueue = () => {
    if (i === array.length) return Promise.resolve();
    const item = array[i++];
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);
    const e = p.then(() => { const idx = executing.indexOf(e); if (idx > -1) executing.splice(idx, 1); }).catch(() => { const idx = executing.indexOf(e); if (idx > -1) executing.splice(idx, 1); });
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
function looksLikeLegacyEntry(item) {
  if (!item || typeof item !== 'object') return false;
  if ('pricing' in item) return true;
  const legacyHints = ['attacks', 'hp', 'types', 'rarity', 'stage', 'retreat', 'dexId'];
  for (const h of legacyHints) if (h in item) return true;
  if ('cardmarket' in item || 'tcgplayer' in item) return false;
  return false;
}

function convertSingleFile(filePath) {
  try {
    const parsed = unzipJson(filePath);
    let arr = null;
    if (Array.isArray(parsed)) arr = parsed;
    else if (parsed && Array.isArray(parsed.cards)) arr = parsed.cards;
    else { console.log(`  - Skipping ${filePath}: not an array and does not contain .cards array.`); return { skipped: true }; }

    const someLegacy = arr.some(looksLikeLegacyEntry);
    if (!someLegacy) { console.log(`  - Skipping ${filePath}: already looks converted.`); return { skipped: true }; }

    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (looksLikeLegacyEntry(item)) {
        const originalId = item.id || null;
        const t = transformDetails(item, originalId);
        if (t) out.push(t);
        else { console.warn(`    ✖ Item ${i} transform returned null -> skipping`); }
      } else out.push(item);
    }

    console.log(`  - Converting ${filePath} (${out.length}/${arr.length} items).`);
    const gz = gzipJson(out);
    if (!DRY_RUN) fs.writeFileSync(filePath, gz);
    console.log(`    ✅ Converted and ${DRY_RUN ? '[dry-run] would overwrite' : 'overwritten'} (no backup).`);
    return { converted: true };
  } catch (err) {
    console.error(`    💥 Error converting ${filePath}:`, err && err.stack ? err.stack : err);
    return { error: true };
  }
}

/* --------------------------
   Main flow
   -------------------------- */
async function main() {
  try {
    console.log("📦 Loading baza.json.gz...");
    if (!fs.existsSync(BASE_PATH)) { console.error(`Brak pliku bazowego: ${BASE_PATH}. Upewnij się, że uruchomiłeś fetch-baza.js.`); process.exit(1); }
    const gzBuf = fs.readFileSync(BASE_PATH);
    const jsonBuf = zlib.gunzipSync(gzBuf);
    const baseCards = JSON.parse(jsonBuf.toString("utf8"));
    if (!Array.isArray(baseCards)) throw new Error("Invalid base response format (expected array)");
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

    try { saveDatedWesternFile(western); } catch (err) { console.error("⚠️ Failed to save dated EN file:", err); }

    // === MIGRATE ALL EXISTING FILES into en/<YEAR>/ (no renames) ===
    migrateAllToYearFolders_NoRename();

    // === AUTOMATIC: convert existing files under en/*/*.json.gz ===
    console.log('\n🔁 Automatic conversion: scanning all existing en/*/*.json.gz files...');
    const files = walkDir(ROOT_EN_DIR);
    console.log(`Found ${files.length} .json.gz files under ${ROOT_EN_DIR}`);

    for (const filePath of files) {
      console.log('➡️', filePath);
      try { convertSingleFile(filePath); } catch (e) { console.error('  💥 Error during convertSingleFile:', e && e.stack ? e.stack : e); }
    }

    console.log('\nConversion pass finished.');
    console.log('\nAll done.');
  } catch (err) {
    console.error("💥 Fatal error:", err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

main();
