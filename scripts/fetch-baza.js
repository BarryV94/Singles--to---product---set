import fs from "fs";

const API_URL = "https://api.tcgdex.net/v2/en/cards";
const OUTPUT = "baza.json";

/**
 * Ensure fetch exists: use global fetch (Node 18+) or try to load undici.
 */
if (typeof fetch === "undefined") {
  try {
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

async function run() {
  console.log("Fetching base card list from TCGdex...");

  const res = await fetch(API_URL, {
    headers: { "User-Agent": "tcgdex-sync-bot" }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch base list: ${res.status}`);
  }

  const data = await res.json();

  if (!Array.isArray(data)) {
    throw new Error("Invalid base response format");
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(data, null, 2));
  console.log(`Saved ${data.length} cards to ${OUTPUT}`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
