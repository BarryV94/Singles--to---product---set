import fs from "fs";
import path from "path";

const BASE_PATH = path.resolve("baza.json");
const OUTPUT_PATH = path.resolve("western.json");

const BASE_URL = "https://api.tcgdex.net/v2/en/cards";
const RATE_LIMIT_DELAY = 120; // ms – bezpieczne dla GH Actions

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Ensure fetch exists: use global fetch (Node 18+) or try to load undici.
 * Jeśli nic nie zadziała — czytelny komunikat i exit(1).
 */
if (typeof fetch === "undefined") {
  try {
    // top-level await is allowed in ESM; spróbuj załadować undici jeśli jest zainstalowane
    const { fetch: undiciFetch } = await import("undici");
    if (typeof undiciFetch === "function") {
      globalThis.fetch = undiciFetch;
    } else {
      console.error('Brak globalnego fetch i "undici" nie dostarczył funkcji fetch.');
      console.error('Zainstaluj undici: npm install undici');
      process.exit(1);
    }
  } catch (e) {
    console.error("Brak globalnego fetch i nie udało się zaimportować 'undici'.");
    console.error("Jeśli używasz starszej wersji Node, zainstaluj undici (`npm i undici`) lub uruchom na Node 18+.");
    process.exit(1);
  }
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

async function main() {
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

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(western, null, 2));
  console.log(`✅ DONE – saved ${western.length} cards to western.json`);
}

main().catch(err => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
