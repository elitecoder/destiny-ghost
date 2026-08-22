import { getInventory } from './profile.js';
import { getAnnotations } from '../dimsync/client.js';
import {
  weaponDupeCounts,
  armorByClassSlot,
  lockTagContradictions,
  namedSetRisk,
  tierBreakdown,
  type VaultItem,
} from '../scoring/vault-report.js';

function locationKind(kind: string): VaultItem['location'] {
  return kind === 'equipped' ? 'character' : (kind as VaultItem['location']);
}

const inv = await getInventory({ force: true });
const tags = new Map((await getAnnotations()).map((a) => [a.id, a.tag ?? undefined]));

const items: VaultItem[] = [];
for (const it of inv.items) {
  if (!it.itemInstanceId) continue;
  items.push({
    itemInstanceId: it.itemInstanceId,
    name: it.name,
    tierType: it.tierType,
    itemType: it.itemType,
    classType: it.classType,
    locked: it.locked,
    location: locationKind(it.location.kind),
    archetype: it.perkColumns[0]?.selected,
    tag: tags.get(it.itemInstanceId),
  });
}

const vaultCount = items.filter((i) => i.location === 'vault').length;
console.log(`\n=== ACCOUNT SNAPSHOT (${items.length} instanced items, ${vaultCount} in vault) ===`);
const tiers = tierBreakdown(items);
for (const [tier, n] of Object.entries(tiers).sort((a, b) => b[1] - a[1])) console.log(`${tier.padEnd(12)} ${n}`);

console.log('\n=== WEAPON DUPES (5+ copies, sorted by count) ===');
console.log('Name'.padEnd(28) + 'Total  Untag  Locked');
for (const r of weaponDupeCounts(items)) {
  console.log(`${r.name.slice(0, 27).padEnd(28)} ${String(r.total).padStart(5)}  ${String(r.untagged).padStart(5)}  ${String(r.locked).padStart(6)}`);
}

console.log('\n=== ARMOR by CLASS x SLOT ===');
console.log('Class/Slot'.padEnd(24) + 'Total  Untag  InfusePend  Keep  Locked');
for (const r of armorByClassSlot(items)) {
  console.log(`${`${r.className}/${r.slot}`.padEnd(24)} ${String(r.total).padStart(5)}  ${String(r.untagged).padStart(5)}  ${String(r.infusePending).padStart(10)}  ${String(r.keep).padStart(4)}  ${String(r.locked).padStart(6)}`);
}

const contradictions = lockTagContradictions(items);
console.log(`\n=== LOCK/TAG CONTRADICTIONS (${contradictions.length}) — junky tag while still locked ===`);
for (const it of contradictions) console.log(`${it.name.padEnd(28)} tag:${it.tag} @ ${it.location} id:${it.itemInstanceId}`);

const setRisks = namedSetRisk(items);
console.log(`\n=== NAMED-SET RISK (${setRisks.length} sets with a junky-tagged piece) ===`);
for (const s of setRisks) {
  console.log(`${s.className}::${s.setName} — ${s.slotsOwned} slots, ${s.piecesOwned} pieces owned`);
  for (const it of s.atRisk) console.log(`   AT RISK: ${it.name.padEnd(26)} tag:${it.tag}  locked:${it.locked}  id:${it.itemInstanceId}`);
}
