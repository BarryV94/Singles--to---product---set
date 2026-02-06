const fs = require('fs');
const zlib = require('zlib');

const API_URL = "https://api.tcgdex.net/v2/en/cards";
const OUTPUT_GZ = "baza.json.gz";

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
    const json = JSON.stringify(data, null, 2);
    const gz = zlib.gzipSync(Buffer.from(json, "utf8"));
    fs.writeFileSync(OUTPUT_GZ, gz);
    console.log(`Saved ${data.length} cards to ${OUTPUT_GZ}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
