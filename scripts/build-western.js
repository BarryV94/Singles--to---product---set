// scripts/build-western.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BASE_PATH = path.resolve("baza.json.gz");
const ROOT_EN_DIR = path.resolve("EN");

const BASE_URL = "https://api.tcgdex.net/v2/en/cards";
const RATE_LIMIT_DELAY = 120; // ms – bezpieczne dla GH Actions
const MAX_FILES_PER_SUBFOLDER = 999;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Pobranie szczegółów karty – NIGDY NIE RZUCA BŁĘDU, zwraca `null` gdy brak danych.
 */
async function fetchCardDetails(cardId) {
  if (!cardId) return null;
  const safeId = encodeURIComponent(decodeURIComponent(cardId));

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

      // 400 / 404 = brak danych → zwróć null (nie retryujemy)
      if (res.status === 400 || res.status === 404) {
        return null;
      }

      // 429 / 5xx → retry z rosnącym opóźnieniem
      if (res.status >= 429) {
        await sleep(300 * attempt);
        continue;
      }

      return null;
    } catch (err) {
      // sieciowe błędy → retry
      await sleep(300 * attempt);
    }
  }

  return null;
}

/**
 * Zapisuje plik do struktury EN/<n>/western_DD_MM_YYYY.json.gz.
 * Tworzy katalog EN oraz podfoldery numerowane automatycznie.
 */
function saveDatedWesternFile(content) {
  // ensure EN root exists
  fs.mkdirSync(ROOT_EN_DIR, { recursive: true });

  // find first folder index with < MAX_FILES_PER_SUBFOLDER files, or create new
  let idx = 1;
  let targetFolder = null;

  while (true) {
    const folderPath = path.join(ROOT_EN_DIR, String(idx));
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
      targetFolder = folderPath;
      break;
    }

    // count files (not directories) in folder
    const entries = fs.readdirSync(folderPath);
    let fileCount = 0;
    for (const e of entries) {
      try {
        const st = fs.statSync(path.join(folderPath, e));
        if (st.isFile()) fileCount++;
      } catch (err) {
        // ignore transient errors
      }
    }

    if (fileCount < MAX_FILES_PER_SUBFOLDER) {
      targetFolder = folderPath;
      break; // use this folder
    }

    idx++;
  }

  // get date in Europe/Warsaw in format DD_MM_YYYY
  const now = new Date();
  const dateStrDots = new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(now); // e.g., "05.02.2026"
  const dateStr = dateStrDots.replace(/\./g, "_"); // "05_02_2026"

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
      // pobieramy WYŁĄCZNIE dane z API dla danego id
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

    // **Nie zapisujemy canonical western.json w repo root** (zgodnie z wymaganiem)
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
