const fs = require('fs');
const path = require('path');

const BASE_PATH = path.resolve("baza.json");
const OUTPUT_PATH = path.resolve("western.json");

const BASE_URL = "https://api.tcgdex.net/v2/en/cards";
const RATE_LIMIT_DELAY = 120; // ms – bezpieczne dla GH Actions
const MAX_FILES_PER_SUBFOLDER = 999;
const ROOT_EN_DIR = path.resolve("EN");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

if (typeof fetch === "undefined") {
  console.error("Global fetch nie jest dostępny. Uruchom na Node >= 18 (Node 20 w CI ma fetch).");
  process.exit(1);
}

/**
 * Bezpieczny deep merge (bez bibliotek)
 */
function deepMerge(target, source) {
  if (!source) return target;

  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key])
    ) {
      target[key] = deepMerge(target[key] ?? {}, source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

/**
 * Fallback – 100% zgodny ze schematem western.json
 */
function buildFallbackCard(base) {
  return {
    category: base.category ?? "",
    id: base.id,
    illustrator: "",
    image: base.image ?? "",
    localId: base.localId ?? "",
    name: base.name ?? "",
    rarity: base.rarity ?? "",
    set: {
      cardCount: base.set?.cardCount ?? { official: null, total: null },
      id: base.set?.id ?? "",
      logo: base.set?.logo ?? "",
      name: base.set?.name ?? "",
      symbol: base.set?.symbol ?? ""
    },
    variants: {
      firstEdition: false,
      holo: false,
      normal: false,
      reverse: false,
      wPromo: false
    },
    variants_detailed: [],
    dexId: [],
    hp: null,
    types: [],
    evolveFrom: "",
    description: "",
    stage: "",
    attacks: [],
    weaknesses: [],
    retreat: null,
    regulationMark: "",
    legal: {
      standard: false,
      expanded: false
    },
    updated: new Date().toISOString(),
    pricing: {
      cardmarket: null,
      tcgplayer: null
    }
  };
}

/**
 * Pobranie szczegółów karty – NIGDY NIE RZUCA BŁĘDU
 */
async function fetchCardDetails(cardId) {
  const safeId = encodeURIComponent(decodeURIComponent(cardId));

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/${safeId}`);

      if (res.ok) {
        return await res.json();
      }

      // 400 / 404 = bug TCGdexa → fallback
      if (res.status === 400 || res.status === 404) {
        return null;
      }

      // 429 / 5xx → retry
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

/**
 * Zapisuje plik do struktury EN/<n>/western_DD_MM_YYYY.json.
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

  const fileName = `western_${dateStr}.json`;
  const filePath = path.join(targetFolder, fileName);

  // write (overwrites if already exists)
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
  console.log(`✅ Saved dated western file: ${filePath}`);
}

async function main() {
  try {
    console.log("📦 Loading baza.json...");
    const baseCards = JSON.parse(fs.readFileSync(BASE_PATH, "utf8"));

    console.log(`🔧 Building western.json from ${baseCards.length} cards...`);

    const western = [];

    for (let i = 0; i < baseCards.length; i++) {
      const base = baseCards[i];

      const fallback = buildFallbackCard(base);
      const details = await fetchCardDetails(base.id);

      const finalCard = details
        ? deepMerge(fallback, details)
        : fallback;

      western.push(finalCard);

      if (i % 500 === 0 && i !== 0) {
        console.log(`✔ processed ${i}/${baseCards.length}`);
      }

      await sleep(RATE_LIMIT_DELAY);
    }

    // Save the canonical western.json in repo root (backwards compatibility)
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(western, null, 2));
    console.log(`✅ DONE – saved ${western.length} cards to ${OUTPUT_PATH}`);

    // Also save dated file inside EN/<n>/western_DD_MM_YYYY.json
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
