#!/usr/bin/env node


for(const [idExpansion,count] of expansions.entries()){
// 1) if mapping exists and provides tcgdexId -> fetch details
const map = mapping[idExpansion];
if(map && map.tcgdexId){
const details = await fetchTcgdexSetDetails(map.tcgdexId).catch(()=>null);
if(details){
outputSets.push({
name: details.name || map.name || `Expansion ${idExpansion}`,
tcgdexId: details.id || map.tcgdexId,
printedCode: map.printedCode || null,
cardmarketExpansionId: map.cardmarketExpansionId || null,
releaseDate: details.releaseDate || null
});
continue;
}
}


// 2) if mapping exists but no tcgdexId, but has printedCode/cardmarketExpansionId
if(map && !map.tcgdexId){
outputSets.push({
name: map.name || `Expansion ${idExpansion}`,
tcgdexId: null,
printedCode: map.printedCode || null,
cardmarketExpansionId: map.cardmarketExpansionId || null,
releaseDate: null
});
continue;
}


// 3) try to find tcgdex set by heuristics: map idExpansion to numeric cardmarket ids is not reliable
// we will attempt to match by printedCode/name if product entries contained such fields (not present by default)
// as a last resort create placeholder


// (No heuristic match implemented because products file usually lacks sufficient info)
outputSets.push(makePlaceholderSet(idExpansion));
unmatched.push(idExpansion);
}


const output = {
version: 2,
lastUpdated: (new Date()).toISOString().slice(0,10),
description: 'Western/European Pokemon TCG set mapping generated (automated). Update .github/expansion-mapping.json to improve matches.',
sets: outputSets
};


await fs.mkdir(path.dirname(OUTPUT_PATH),{recursive:true});
await fs.writeFile(OUTPUT_PATH, JSON.stringify(output,null,2),'utf8');
console.log('Written:', OUTPUT_PATH);


if(unmatched.length){
console.warn('Unmatched expansions (no mapping / no TCGdex match):', unmatched.slice(0,50));
// if mapping file didn't exist, write a sample mapping template
if(Object.keys(mapping).length === 0){
const template = {};
for(const id of unmatched){
template[id] = {
tcgdexId: null,
printedCode: null,
cardmarketExpansionId: null,
name: `Expansion ${id}`
};
}
await fs.mkdir(path.dirname(MAPPING_PATH),{recursive:true});
await fs.writeFile(MAPPING_PATH + '.sample', JSON.stringify(template,null,2),'utf8');
console.log('Wrote mapping template to', MAPPING_PATH + '.sample');
}
}


console.log('Done');
process.exit(0);
})().catch(err=>{ console.error(err); process.exit(3); });
