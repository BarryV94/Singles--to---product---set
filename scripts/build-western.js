const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BASE_PATH = path.resolve("baza.json.gz");
const ROOT_EN_DIR = path.resolve("EN");
const BASE_URL = "https://api.tcgdex.net/v2/en/cards";
const RATE_LIMIT_DELAY = 120;
const MAX_FILES_PER_SUBFOLDER = 999;

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
  } catch (e) {}
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
    const western = [];
    for (let i = 0; i < baseCards.length; i++) {
      const base = baseCards[i];
      const details = await fetchCardDetails(base.id);
      if (details) {
        western.push(details);
      } else {
        console.warn(`⚠️ Missing details for id=${base.id} (skipping)`);
      }
      if (i % 500 === 0 && i !== 0) {
        console.log(`✔ processed ${i}/${baseCards.length}`);
      }
      await sleep(RATE_LIMIT_DELAY);
    }
    console.log(`✅ DONE – collected ${western.length} detailed cards. Now saving dated file...`);
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
