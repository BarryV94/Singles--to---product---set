#!/usr/bin/env node
/**
 * generate_western_sets.js
 *
 * - Pobiera wszystkie idProduct z products_singles_6.json
 * - Dla każdego idProduct wykona zapytanie:
 *     GET https://api.tcgdex.net/v2/en/cards?pricing.cardmarket.idProduct={idProduct}&pagination:itemsPerPage=50
 * - Jeśli TCGdex zwróci karty, weź pierwszy wynik (lub najlepszy) i zapisz pełen obiekt do western_sets.json
 * - Jeśli brak wyniku, zapisz placeholder + wpis do suggestions
 *
 * Node 20 required (global fetch dostępny).
 */

const fs = require('fs/promises');
const path = require('path');

async function safeReadJSON(p){ try{ return JSON.parse(await fs.readFile(p,'utf8')); } catch(e){ return null; } }
async function sleep(ms){ return new Promise(res => setTimeout(res, ms)); }

async function findFileRecursive(startDir, targetName){
  const queue = [startDir];
  while(queue.length){
    const dir = queue.shift();
    let entries;
    try{ entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch(e){ continue; }
    for(const ent of entries){
      const full = path.join(dir, ent.name);
      if(ent.isFile() && ent.name === targetName) return full;
      if(ent.isDirectory() && !ent.name.startsWith('.git') && !ent.name.startsWith('node_modules')) queue.push(full);
    }
  }
  return null;
}

async function tcgdexQueryByCardmarketId(idProduct){
  if(!idProduct) return null;
  const url = `https://api.tcgdex.net/v2/en/cards?pricing.cardmarket.idProduct=${encodeURIComponent(idProduct)}&pagination:itemsPerPage=50`;
  try{
    const r = await fetch(url);
    if(!r.ok) {
      // non-200 — return null (we'll retry per-item lightly)
      return { error: `HTTP ${r.status}`, url };
    }
    const arr = await r.json();
    if(Array.isArray(arr) && arr.length > 0) return { cards: arr };
    return { cards: [] };
  } catch(e){
    return { error: e.message };
  }
}

(async function main(){
  try{
    const cwd = process.cwd();
    const productsFile = await findFileRecursive(cwd, 'products_singles_6.json');
    if(!productsFile){
      console.error('Nie znaleziono products_singles_6.json w repo. Umieść plik i uruchom ponownie.');
      process.exit(2);
    }
    console.log('Znaleziono:', productsFile);

    const productsJson = await safeReadJSON(productsFile);
    if(!productsJson){
      console.error('Błąd odczytu products_singles_6.json');
      process.exit(3);
    }

    const productsArr = Array.isArray(productsJson.products) ? productsJson.products : (Array.isArray(productsJson) ? productsJson : null);
    if(!productsArr){
      console.error('Oczekiwano products: [] lub root array w products_singles_6.json');
      process.exit(4);
    }

    // zbierz unikalne idProduct
    const idProductsSet = new Set();
    for(const p of productsArr){
      // obsłuż różne nazwy pola jeśli to potrzebne; tu przyjmujemy idProduct
      const idProd = p.idProduct ?? p.id_product ?? p.idProductRaw ?? null;
      if(idProd != null) idProductsSet.add(String(idProd));
    }
    const idProducts = Array.from(idProductsSet);
    console.log('Znaleziono idProduct:', idProducts.length);

    const westernCards = []; // tablica pełnych obiektów TCGdex lub placeholderów
    const suggestions = {};  // idProduct -> info jeżeli brak dopasowania lub konflikty

    // iterate and query TCGdex
    for(let i=0;i<idProducts.length;i++){
      const idProduct = idProducts[i];
      console.log(`[${i+1}/${idProducts.length}] Querying TCGdex for idProduct=${idProduct} ...`);
      const res = await tcgdexQueryByCardmarketId(idProduct);

      // rate-limit small delay to be polite
      await sleep(200);

      if(res && res.error){
        console.warn(`  - Query error for ${idProduct}:`, res.error);
        // push placeholder with error
        westernCards.push({
          category: null,
          id: null,
          tcgdexQuery: { idProduct, error: res.error },
          notFound: true,
          originalCardmarketId: idProduct
        });
        suggestions[idProduct] = { idProduct, error: res.error, candidates: [] };
        continue;
      }

      if(res && Array.isArray(res.cards) && res.cards.length > 0){
        // If multiple cards returned, try select best:
        // prefer exact card where pricing.cardmarket.idProduct === idProduct (should be true),
        // otherwise take first.
        const cards = res.cards;
        let chosen = cards[0];

        // if there is exactly one or first is fine, choose it; else try to prefer card with exact idProduct in pricing.cardmarket.idProduct
        if(cards.length > 1){
          const exact = cards.find(c => {
            try{ return c.pricing && c.pricing.cardmarket && String(c.pricing.cardmarket.idProduct) === String(idProduct); }catch(e){return false;}
          });
          if(exact) chosen = exact;
        }

        // write the full TCGdex card object as-is (user wanted full structure)
        westernCards.push(chosen);

        // also create suggestion entry with basic metadata for traceability
        suggestions[idProduct] = {
          idProduct,
          found: true,
          tcgdexId: chosen.id,
          name: chosen.name,
          localId: chosen.localId,
          setId: chosen.set?.id || null,
          setName: chosen.set?.name || null,
          pricing: chosen.pricing || null
        };
      } else {
        console.log(`  - No card found in TCGdex for idProduct=${idProduct}`);
        westernCards.push({
          category: null,
          id: null,
          notFound: true,
          originalCardmarketId: idProduct
        });
        suggestions[idProduct] = { idProduct, found: false, candidates: [] };

        // optionally: try name-based search for suggestions (skip heavy calls by default)
      }
    }

    // output structure: array of full card objects (or placeholders)
    const output = westernCards;

    // write next to products file
    const outDir = path.dirname(productsFile);
    const outPath = path.join(outDir, 'western_sets.json');
    await fs.writeFile(outPath, JSON.stringify(output, null, 2), 'utf8');
    console.log('Zapisano:', outPath);

    // write copy in repo root
    const rootOut = path.join(cwd, 'western_sets.json');
    await fs.writeFile(rootOut, JSON.stringify(output, null, 2), 'utf8');
    console.log('Zapisano kopię:', rootOut);

    // write suggestions
    const suggestionsPath = path.join(cwd, '.github', 'expansion-mapping.suggestions.json');
    await fs.mkdir(path.dirname(suggestionsPath), { recursive: true });
    await fs.writeFile(suggestionsPath, JSON.stringify(suggestions, null, 2), 'utf8');
    console.log('Zapisano suggestions:', suggestionsPath);

    console.log('Gotowe.');
    process.exit(0);

  } catch(err){
    console.error('Błąd główny skryptu:', err);
    process.exit(99);
  }
})();
