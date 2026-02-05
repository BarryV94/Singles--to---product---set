#!/usr/bin/env node
/**
 * generate_western_sets.js
 * - znajdź products_singles_6.json rekurencyjnie w repo
 * - pobierz listę setów z TCGdex
 * - spróbuj dopasować idExpansion -> tcgdexId przy pomocy fuzzy matchingu nazw
 * - zapisz western_sets.json obok pliku products_singles_6.json
 * - zapisz także kopię w repo root jako ./western_sets.json (łatwe commitowanie)
 * - zapisz .github/expansion-mapping.suggestions.json z kandydatami
 *
 * Node 20 required (fetch global available)
 */

const fs = require('fs/promises');
const path = require('path');

async function findFileRecursive(startDir, targetName) {
  const queue = [startDir];
  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isFile() && ent.name === targetName) {
        return full;
      }
      if (ent.isDirectory() && !ent.name.startsWith('.git') && !ent.name.startsWith('node_modules')) {
        queue.push(full);
      }
    }
  }
  return null;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const v0 = new Array(bl + 1).fill(0);
  const v1 = new Array(bl + 1).fill(0);
  for (let j = 0; j <= bl; j++) v0[j] = j;
  for (let i = 0; i < al; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < bl; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= bl; j++) v0[j] = v1[j];
  }
  return v1[bl];
}

function normalizedSimilarity(a, b) {
  a = (a || '').toLowerCase().trim();
  b = (b || '').toLowerCase().trim();
  if (!a || !b) return 0;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - dist / maxLen;
}

function tokenOverlapScore(a, b) {
  const aw = (a || '').toLowerCase().split(/\W+/).filter(Boolean);
  const bw = (b || '').toLowerCase().split(/\W+/).filter(Boolean);
  if (!aw.length || !bw.length) return 0;
  const aset = new Set(aw);
  let common = 0;
  for (const w of bw) if (aset.has(w)) common++;
  const score = common / Math.max(aw.length, bw.length);
  return score;
}

async function safeReadJSON(p) {
  try {
    const txt = await fs.readFile(p, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

async function fetchTcgdexSets() {
  const url = 'https://api.tcgdex.net/v2/en/sets';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TCGdex sets fetch failed: ${res.status}`);
  return await res.json();
}

async function fetchTcgdexSetDetails(id) {
  try {
    const url = `https://api.tcgdex.net/v2/en/sets/${encodeURIComponent(id)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

(async function main() {
  console.log('Starting generator (repo-aware)...');

  const cwd = process.cwd();
  const productsFile = await findFileRecursive(cwd, 'products_singles_6.json');

  if (!productsFile) {
    console.error('Nie znalazłem pliku products_singles_6.json w repo. Umieść go w repo i uruchom ponownie.');
    process.exit(2);
  }

  console.log('Znaleziono products file:', productsFile);
  const productsJson = await safeReadJSON(productsFile);
  if (!productsJson) {
    console.error('Nie można odczytać JSON z products_singles_6.json lub format jest nieoczekiwany.');
    process.exit(3);
  }

  const productsArr = Array.isArray(productsJson.products) ? productsJson.products : (Array.isArray(productsJson) ? productsJson : null);
  if (!productsArr) {
    console.error('Nie znalazłem tablicy produktów w products_singles_6.json (oczekiwano products: [] lub root array).');
    process.exit(4);
  }

  const expansions = new Map();
  for (const p of productsArr) {
    const ex = (p.idExpansion != null) ? String(p.idExpansion) : null;
    if (!ex) continue;
    const entry = expansions.get(ex) || { count: 0, names: new Set(), samples: [] };
    entry.count++;
    if (p.name) {
      entry.names.add(p.name);
      if (entry.samples.length < 5) entry.samples.push(p.name);
    }
    expansions.set(ex, entry);
  }

  console.log('Znalezione unikalne idExpansion:', expansions.size);

  const mappingPath = path.join(cwd, '.github', 'expansion-mapping.json');
  const existingMapping = await safeReadJSON(mappingPath) || {};

  let tcgSets = [];
  try {
    tcgSets = await fetchTcgdexSets();
    console.log('Pobrano listę zestawów z TCGdex, count =', tcgSets.length);
  } catch (e) {
    console.warn('Nie udało się pobrać TCGdex sets:', e.message);
    tcgSets = [];
  }

  const outputSets = [];
  const suggestions = {};

  for (const [idExpansion, info] of expansions.entries()) {
    const sampleNames = Array.from(info.names).slice(0, 10).join(' | ');
    const mapped = existingMapping[idExpansion];
    if (mapped && mapped.tcgdexId) {
      const details = await fetchTcgdexSetDetails(mapped.tcgdexId).catch(()=>null);
      outputSets.push({
        idExpansion,
        name: details?.name || mapped.name || `Expansion ${idExpansion}`,
        tcgdexId: mapped.tcgdexId,
        printedCode: mapped.printedCode || null,
        cardmarketExpansionId: mapped.cardmarketExpansionId || null,
        releaseDate: details?.releaseDate || null,
        productCount: info.count
      });
      continue;
    }

    const candidateScores = [];
    if (tcgSets.length > 0) {
      for (const s of tcgSets) {
        const nameSim = normalizedSimilarity(s.name || '', sampleNames);
        const tokenScore = tokenOverlapScore(s.name || '', sampleNames);
        const combined = nameSim * 0.7 + tokenScore * 0.3;
        candidateScores.push({ tcgdexId: s.id, tcgdexName: s.name, score: combined });
      }
      candidateScores.sort((a,b) => b.score - a.score);
    }

    const top = candidateScores.slice(0,5).filter(c => c.score > 0.25);
    suggestions[idExpansion] = {
      samples: info.samples,
      candidates: top
    };

    if (top.length > 0 && top[0].score > 0.45) {
      const best = top[0];
      const details = await fetchTcgdexSetDetails(best.tcgdexId).catch(()=>null);
      outputSets.push({
        idExpansion,
        name: details?.name || best.tcgdexName || `Expansion ${idExpansion}`,
        tcgdexId: best.tcgdexId,
        printedCode: null,
        cardmarketExpansionId: null,
        releaseDate: details?.releaseDate || null,
        productCount: info.count,
        autoMatched: true,
        matchScore: best.score
      });
    } else {
      outputSets.push({
        idExpansion,
        name: `Expansion ${idExpansion}`,
        tcgdexId: null,
        printedCode: null,
        cardmarketExpansionId: null,
        releaseDate: null,
        productCount: info.count,
        autoMatched: false
      });
    }
  }

  const out = {
    version: 2,
    generatedAt: new Date().toISOString(),
    description: 'Automated generation (with fuzzy matching) - review .github/expansion-mapping.suggestions.json to improve matches.',
    sets: outputSets
  };

  // write western_sets.json next to products file
  const outDir = path.dirname(productsFile);
  const outPath = path.join(outDir, 'western_sets.json');

  try {
    await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');
    console.log('Zapisano western_sets.json ->', outPath);
  } catch (e) {
    console.error('Błąd zapisu western_sets.json obok products:', e);
  }

  // also write a copy in repo root to make committing easier
  const rootOutPath = path.join(cwd, 'western_sets.json');
  try {
    await fs.writeFile(rootOutPath, JSON.stringify(out, null, 2), 'utf8');
    console.log('Zapisano kopię western_sets.json w repo root ->', rootOutPath);
  } catch (e) {
    console.error('Błąd zapisu western_sets.json w repo root:', e);
  }

  // write suggestions mapping file to .github (for manual review)
  const suggestionsPath = path.join(cwd, '.github', 'expansion-mapping.suggestions.json');
  try {
    await fs.mkdir(path.dirname(suggestionsPath), { recursive: true });
    await fs.writeFile(suggestionsPath, JSON.stringify(suggestions, null, 2), 'utf8');
    console.log('Zapisano suggestions ->', suggestionsPath);
  } catch (e) {
    console.error('Błąd zapisu suggestions:', e);
  }

  // optionally write sample mapping if none existed
  if (Object.keys(existingMapping).length === 0) {
    const sample = {};
    for (const s of outputSets) {
      sample[s.idExpansion] = {
        tcgdexId: s.tcgdexId || null,
        printedCode: s.printedCode || null,
        cardmarketExpansionId: s.cardmarketExpansionId || null,
        name: s.name
      };
    }
    const samplePath = path.join(cwd, '.github', 'expansion-mapping.sample.json');
    try {
      await fs.writeFile(samplePath, JSON.stringify(sample, null, 2), 'utf8');
      console.log('Zapisano sample mapping ->', samplePath);
    } catch (e) {
      console.error('Błąd zapisu sample mapping:', e);
    }
  }

  console.log('Done.');
  process.exit(0);
})().catch(err => {
  console.error('Błąd skryptu:', err);
  process.exit(10);
});
