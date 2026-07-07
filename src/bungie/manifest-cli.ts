import { ensureManifest, itemName } from './manifest.js';

const m = await ensureManifest();
const itemCount = Object.keys(m.tables.DestinyInventoryItemDefinition).length;
console.log(`[ghost] Manifest ${m.version} cached — ${itemCount} item definitions.`);
// Spot-check the resolver: Fatebringer is a well-known hand cannon hash.
console.log('[ghost] Sample resolve 2171478765 →', itemName(2171478765));
