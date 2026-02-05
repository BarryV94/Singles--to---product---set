#!/usr/bin/env node
/**
 * generate_western_sets.js
 *
 * Cel:
 * - Dla każdego produktu w products_singles_6.json (mającego idProduct i idExpansion)
 *   spróbuj znaleźć odpowiadającą kartę w TCGdex:
 *     1) query by pricing.cardmarket.idProduct == idProduct
 *     2) fallback: query by set.id == tcgdexSetId && localId == productLocalId (jeżeli mamy mapowanie)
 *     3) fallback: fuzzy match by name + set
 * - W wynikowym western_sets.json dla każdego produktu dodaj tcgplayerProductId (pricing.tcgplayer.normal.productId),
 *   tcgdexCardId (np. swsh3-136) oraz krótki tcgdexCardBrief.
 * - Zapisz także suggestions (.github/expansion-mapping.suggestions.json) do ręcznej weryfikacji.
 *
 * Node 20 required (fetch global available).
 */

const fs = require('fs/promises');
const path = require('path');

async function safeReadJSON(p){ try{ const t = await fs.readFile(p,'utf8'); return JSON.parse(t);}catch(e){return null;} }

async function findFileRecursive(startDir, targetName){
  const queue = [startDir];
  while(queue.length){
    const dir = queue.shift();
    let entries;
    try{ entries = await fs.readdir(dir, { withFileTypes: true }); } catch(e){ continue; }
    for(const ent of entries){
      const full = path.join(dir, ent.name);
      if(ent.isFile() && ent.name === targetName) return full;
      if(ent.isDirectory() && !ent.name.startsWith('.git') && !ent.name.startsWith('node_modules')) queue.push(full);
    }
  }
  return null;
}

/* ---- simple string similarity utils ---- */
function levenshtein(a,b){
  a = a||''; b = b||'';
  const al=a.length, bl=b.length;
  if(al===0) return bl; if(bl===0) return al;
  const v0=new Array(bl+1).fill(0), v1=new Array(bl+1).fill(0);
  for(let j=0;j<=bl;j++) v0[j]=j;
  for(let i=0;i<al;i++){
    v1[0]=i+1;
    for(let j=0;j<bl;j++){
      const cost = a[i]===b[j]?0:1;
      v1[j+1] = Math.min(v1[j]+1, v0[j+1]+1, v0[j]+cost);
    }
    for(let j=0;j<=bl;j++) v0[j]=v1[j];
  }
  return v1[bl];
}
function normSim(a,b){
  a=(a||'').toLowerCase().trim(); b=(b||'').toLowerCase().trim();
  if(!a||!b) return 0;
  const dist=levenshtein(a,b);
  return 1 - dist / Math.max(a.length,b.length);
}
function tokenOverlap(a,b){
  const aw=(a||'').toLowerCase().split(/\W+/).filter(Boolean);
  const bw=(b||'').toLowerCase().split(/\W+/).filter(Boolean);
  if(!aw.length||!bw.length) return 0;
  const aset=new Set(aw);
  let common=0; for(const w of bw) if(aset.has(w)) common++;
  return common / Math.max(aw.length,bw.length);
}

/* ---- TCGdex helpers ---- */
async function tcgdexFetch(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`TCGdex fetch failed ${res.status} for ${url}`);
  return res.json();
}

/* Try to find card by cardmarket idProduct */
async function findCardByCardmarketId(idProduct){
  if(!idProduct) return null;
  const url = `https://api.tcgdex.net/v2/en/cards?pricing.cardmarket.idProduct=${encodeURIComponent(idProduct)}&pagination:itemsPerPage=50`;
  try{
    const arr = await tcgdexFetch(url);
    if(Array.isArray(arr) && arr.length>0) return arr[0]; // take first exact match
  }catch(e){ /* ignore */ }
  return null;
}

/* Try to find card by set id + localId */
async function findCardBySetAndLocalId(tcgdexSetId, localId){
  if(!tcgdexSetId || !localId) return null;
  const url = `https://api.tcgdex.net/v2/en/cards?set.id=${encodeURIComponent(tcgdexSetId)}&localId=${encodeURIComponent(String(localId))}&pagination:itemsPerPage=20`;
  try{
    const arr = await tcgdexFetch(url);
    if(Array.isArray(arr) && arr.length>0) return arr[0];
  }catch(e){}
  return null;
}

/* Fallback: search by name (lax) returning top candidate list */
async function searchCardsByName(name){
  if(!name) return [];
  const url = `https://api.tcgdex.net/v2/en/cards?name=${encodeURIComponent(name)}&pagination:itemsPerPage=10`;
  try{
    const arr = await tcgdexFetch(url);
    if(Array.isArray(arr)) return arr;
  }catch(e){}
  return [];
}

/* ---- main ---- */
(async function main(){
  const cwd = process.cwd();
  const productsFile = await findFileRecursive(cwd, 'products_singles_6.json');
  if(!productsFile){
    console.error('Nie znaleziono products_singles_6.json w repo. Umieść plik i spróbuj ponownie.');
    process.exit(2);
  }
  console.log('Products file:', productsFile);

  const productsJson = await safeReadJSON(productsFile);
  if(!productsJson){
    console.error('Błąd odczytu JSON products_singles_6.json');
    process.exit(3);
  }
  const productsArr = Array.isArray(productsJson.products) ? productsJson.products : (Array.isArray(productsJson)?productsJson: null);
  if(!productsArr){
    console.error('Oczekiwano products: [] lub root array w products_singles_6.json');
    process.exit(4);
  }

  // read optional mapping file idExpansion -> tcgdexSetId (user may have filled)
  const mappingPath = path.join(cwd, '.github','expansion-mapping.json');
  const mapping = await safeReadJSON(mappingPath) || {};

  // group products by idExpansion and also keep flat list
  const byExpansion = new Map();
  for(const p of productsArr){
    const idExp = (p.idExpansion != null) ? String(p.idExpansion) : null;
    const idProd = p.idProduct != null ? p.idProduct : null; // Cardmarket product id
    const localCandidates = [];
    if(p.localId) localCandidates.push(p.localId);
    if(p.number) localCandidates.push(p.number);
    if(p.printedNumber) localCandidates.push(p.printedNumber);
    if(p.collectorNumber) localCandidates.push(p.collectorNumber);
    const item = { raw: p, idProduct: idProd, idExpansion: idExp, localCandidates, name: p.name || p.title || '' };
    if(!byExpansion.has(idExp)) byExpansion.set(idExp, []);
    byExpansion.get(idExp).push(item);
  }

  console.log('Znalezione ekspansji:', byExpansion.size);

  // We'll build output: map of expansions -> products with added fields
  const output = { generatedAt: new Date().toISOString(), sets: [] };
  const suggestions = {}; // idProduct -> candidates etc.

  // iterate expansions
  for(const [idExp, items] of byExpansion.entries()){
    // try to get tcgdexSetId from mapping if present
    const map = mapping[idExp] || {};
    const tcgdexSetId = map.tcgdexId || null;

    const setObj = { idExpansion: idExp, tcgdexSetId: tcgdexSetId, products: [] };

    for(const it of items){
      const prodOut = {
        idProduct: it.idProduct,
        idExpansion: it.idExpansion,
        name: it.name,
        tcgdexCardId: null,
        tcgplayerProductId: null,
        tcgdexCardBrief: null,
        matchConfidence: 0,
        matchedBy: null
      };

      // 1) attempt by cardmarket product id
      if(it.idProduct){
        try{
          const card = await findCardByCardmarketId(it.idProduct);
          if(card){
            prodOut.tcgdexCardId = card.id;
            prodOut.tcgplayerProductId = card.pricing?.tcgplayer?.normal?.productId || null;
            prodOut.tcgdexCardBrief = {
              id: card.id, name: card.name, localId: card.localId, set: card.set?.id, setName: card.set?.name, rarity: card.rarity, image: card.image
            };
            prodOut.matchConfidence = 1.0;
            prodOut.matchedBy = 'cardmarket-id';
            setObj.products.push(prodOut);
            continue; // next product
          }
        }catch(e){
          // ignore and continue with next strategies
        }
      }

      // 2) attempt by set + localId (if we have localCandidates and tcgdexSetId)
      let found = null;
      if(tcgdexSetId && it.localCandidates && it.localCandidates.length){
        for(const local of it.localCandidates){
          try{
            const card = await findCardBySetAndLocalId(tcgdexSetId, local);
            if(card){
              found = card; break;
            }
          }catch(e){}
        }
        if(found){
          prodOut.tcgdexCardId = found.id;
          prodOut.tcgplayerProductId = found.pricing?.tcgplayer?.normal?.productId || null;
          prodOut.tcgdexCardBrief = { id: found.id, name: found.name, localId: found.localId, set: found.set?.id, setName: found.set?.name, rarity: found.rarity, image: found.image };
          prodOut.matchConfidence = 0.95;
          prodOut.matchedBy = 'set+localId';
          setObj.products.push(prodOut);
          continue;
        }
      }

      // 3) try search by name and evaluate best candidate (fuzzy)
      const searchCandidates = await searchCardsByName(it.name || '');
      let best = null;
      if(searchCandidates.length){
        for(const c of searchCandidates){
          // compute score: combine name sim + token overlap, and bonus if set matches map.tcgdexId
          const nameSim = normSim(c.name || '', it.name || '');
          const token = tokenOverlap(c.name || '', it.name || '');
          let score = nameSim * 0.7 + token * 0.3;
          if(tcgdexSetId && c.set && c.set.id === tcgdexSetId) score += 0.2;
          if(best === null || score > best.score){ best = { card: c, score }; }
        }
      }

      if(best && best.score > 0.45){
        const c = best.card;
        prodOut.tcgdexCardId = c.id;
        prodOut.tcgplayerProductId = c.pricing?.tcgplayer?.normal?.productId || null;
        prodOut.tcgdexCardBrief = { id: c.id, name: c.name, localId: c.localId, set: c.set?.id, setName: c.set?.name, rarity: c.rarity, image: c.image };
        prodOut.matchConfidence = Math.min(1, best.score);
        prodOut.matchedBy = 'name-fuzzy';
        setObj.products.push(prodOut);
        continue;
      }

      // no confident match -> push placeholder and add suggestions entry
      prodOut.matchedBy = 'none';
      prodOut.matchConfidence = 0;
      setObj.products.push(prodOut);

      // prepare suggestion candidates: prefer cardmarket id search + name search top 5
      const sugg = { idProduct: it.idProduct, idExpansion: it.idExpansion, name: it.name, candidates: [] };
      // candidate by cardmarket id might have been null, but we can still attempt a direct fetch by card id ?? (skip)
      // add top name search candidates
      for(const c of searchCandidates.slice(0,6)){
        sugg.candidates.push({ id: c.id, name: c.name, localId: c.localId, setId: c.set?.id, setName: c.set?.name });
      }
      suggestions[it.idProduct || (`exp-${it.idExpansion}_${it.name.substr(0,20)}`)] = sugg;
    } // end products loop

    output.sets.push(setObj);
  } // end expansion loop

  // write output next to products file and copy to repo root
  const outDir = path.dirname(productsFile);
  const outPath = path.join(outDir, 'western_sets.json');
  try{ await fs.writeFile(outPath, JSON.stringify(output,null,2),'utf8'); console.log('Zapisano', outPath); }
  catch(e){ console.error('Błąd zapisu', outPath, e); }

  const rootCopy = path.join(cwd, 'western_sets.json');
  try{ await fs.writeFile(rootCopy, JSON.stringify(output,null,2),'utf8'); console.log('Zapisano kopię', rootCopy); }
  catch(e){ console.error('Błąd zapisu kopii', e); }

  // write suggestions
  const suggestionsPath = path.join(cwd, '.github','expansion-mapping.suggestions.json');
  try{
    await fs.mkdir(path.dirname(suggestionsPath), { recursive: true });
    await fs.writeFile(suggestionsPath, JSON.stringify(suggestions,null,2),'utf8');
    console.log('Zapisano suggestions ->', suggestionsPath);
  }catch(e){ console.error('Błąd zapisu suggestions', e); }

  // done
  console.log('Gotowe.');
  process.exit(0);

})().catch(err => { console.error('Błąd skryptu:', err); process.exit(99); });
