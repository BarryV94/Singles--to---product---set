const fs = require('fs');

const API_URL = "https://api.tcgdex.net/v2/en/cards";
const OUTPUT = "baza.json";

if (typeof fetch === "undefined") {
  console.error("Global fetch nie jest dostępny. Uruchom na Node >= 18 (Twój runner powinien mieć Node 20).");
  process.exit(1);
}

async function run() {
  try {
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
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
