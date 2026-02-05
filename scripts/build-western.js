import fs from "fs";

const BASE_FILE = "baza.json";
const OUTPUT_FILE = "western.json";
const API_ROOT = "https://api.tcgdex.net/v2/en/cards";
const CONCURRENCY = 8;
const RETRIES = 3;
const DELAY_MS = 120;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchCard(id, attempt = 1) {
  try {
    const res = await fetch(`${API_ROOT}/${id}`, {
      headers: { "User-Agent": "tcgdex-sync-bot" }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    return await res.json();
  } catch (err) {
    if (attempt < RETRIES) {
      await sleep(500 * attempt);
      return fetchCard(id, attempt + 1);
    }
    console.warn(`❌ Failed card ${id}: ${err.message}`);
    return null;
  }
}

async function run() {
  if (!fs.existsSync(BASE_FILE)) {
    throw new Error("baza.json not found");
  }

  const base = JSON.parse(fs.readFileSync(BASE_FILE, "utf8"));
  const ids = base.map(c => c.id).filter(Boolean);

  console.log(`Building western.json from ${ids.length} cards...`);

  const cards = {};
  let index = 0;

  async function worker() {
    while (index < ids.length) {
      const id = ids[index++];
      const card = await fetchCard(id);
      if (card) {
        cards[id] = card;
      }
      await sleep(DELAY_MS);
    }
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => worker())
  );

  const output = {
    meta: {
      source: "tcgdex",
      language: "en",
      generatedAt: new Date().toISOString(),
      totalCards: Object.keys(cards).length
    },
    cards
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`Saved ${output.meta.totalCards} cards to ${OUTPUT_FILE}`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
