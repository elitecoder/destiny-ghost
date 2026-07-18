import {
  equipItem,
  equipItems,
  pullFromPostmaster,
  setItemLockState,
  transferItem,
} from 'bungie-api-ts/destiny2';
import { authedHttp } from './client.js';
import { getInventory, invalidateInventory, patchLockState, type GhostItem } from './profile.js';

/**
 * Write actions against the Bungie API. Every mutation here is reversible at
 * the account level — there is NO dismantle/delete endpoint in the Bungie API,
 * so the worst any of these can do is misplace or unlock an item. Callers
 * (the tool layer) still gate these behind an explicit user confirmation.
 */

async function findInstance(itemInstanceId: string): Promise<GhostItem | undefined> {
  const inv = await getInventory({ force: true });
  return inv.items.find((i) => i.itemInstanceId === itemInstanceId);
}

/** Move one item to the vault (from wherever it currently is). */
export async function moveToVault(item: GhostItem, characterId: string): Promise<void> {
  await transferItem(authedHttp, {
    itemReferenceHash: item.itemHash,
    stackSize: 1,
    transferToVault: true,
    itemId: item.itemInstanceId!,
    characterId,
    membershipType: (await getInventory()).membership.membershipType,
  });
  invalidateInventory();
}

/** Pull one item from the vault onto a character. */
export async function pullFromVault(item: GhostItem, characterId: string): Promise<void> {
  await transferItem(authedHttp, {
    itemReferenceHash: item.itemHash,
    stackSize: 1,
    transferToVault: false,
    itemId: item.itemInstanceId!,
    characterId,
    membershipType: (await getInventory()).membership.membershipType,
  });
  invalidateInventory();
}

export interface TransferStep {
  action: 'vault' | 'unvault';
  characterId: string;
  description: string;
}

/**
 * Compute the ordered steps to move an item to a destination. char→char is not
 * a single API call — it routes through the vault (research CONFIRMED), so a
 * cross-character move is two steps. Returns the plan without executing.
 */
export function planTransfer(item: GhostItem, destination: 'vault' | string): TransferStep[] {
  const loc = item.location;
  const currentChar =
    loc.kind === 'character' || loc.kind === 'equipped' || loc.kind === 'postmaster'
      ? loc.characterId
      : undefined;

  if (destination === 'vault') {
    if (loc.kind === 'vault') return [];
    return [{ action: 'vault', characterId: currentChar!, description: `Move ${item.name} to the vault` }];
  }

  // Destination is a characterId.
  if (loc.kind === 'character' && loc.characterId === destination) return [];
  const steps: TransferStep[] = [];
  if (currentChar && currentChar !== destination) {
    steps.push({ action: 'vault', characterId: currentChar, description: `Move ${item.name} to the vault` });
  }
  steps.push({ action: 'unvault', characterId: destination, description: `Pull ${item.name} onto the destination character` });
  return steps;
}

/**
 * Execute a transfer plan idempotently: before each step, re-read the item's
 * location and skip steps already satisfied (so a retried run never
 * double-moves). Returns the steps actually executed.
 */
export async function executeTransfer(itemInstanceId: string, destination: 'vault' | string): Promise<string[]> {
  const done: string[] = [];
  for (let i = 0; i < 4; i++) {
    const item = await findInstance(itemInstanceId);
    if (!item) throw new Error(`Item ${itemInstanceId} not found in inventory.`);
    const remaining = planTransfer(item, destination);
    if (remaining.length === 0) break;
    const step = remaining[0];
    if (step.action === 'vault') await moveToVault(item, step.characterId);
    else await pullFromVault(item, step.characterId);
    done.push(step.description);
  }
  return done;
}

/** Equip a single item on the character it currently sits on. */
export async function equipOne(item: GhostItem, characterId: string): Promise<void> {
  await equipItem(authedHttp, {
    itemId: item.itemInstanceId!,
    characterId,
    membershipType: (await getInventory()).membership.membershipType,
  });
  invalidateInventory();
}

/** Equip many items at once; returns per-item equip status codes. */
export async function equipMany(
  itemIds: string[],
  characterId: string,
): Promise<Array<{ itemInstanceId: string; equipStatus: number }>> {
  const res = (
    await equipItems(authedHttp, {
      itemIds,
      characterId,
      membershipType: (await getInventory()).membership.membershipType,
    })
  ).Response;
  invalidateInventory();
  return (res.equipResults ?? []).map((r) => ({
    itemInstanceId: r.itemInstanceId,
    equipStatus: r.equipStatus,
  }));
}

/**
 * Lock or unlock an item (reversible; the vault-cleaner keep/reject action).
 *
 * Trust the SetLock response, NOT a read-back. The HTTP client returns only on
 * ErrorCode 1 (Success) and throws BungieError otherwise, so a normal return
 * means the write was accepted. We patch the cached snapshot locally rather than
 * verifying via GetProfile, because GetProfile is eventually-consistent — it
 * lags the write by 30-40s (its responses are CDN-cached) — so an immediate
 * forced refetch reads the OLD lock state, reports a false "failed", AND caches
 * that stale state for the full TTL. (The old "only one of three characters
 * works, confirm by refetch" belief was itself a misread of this lag.)
 *
 * We still try each character in turn, because a character CANNOT act on an item
 * held by a DIFFERENT character — that throws DestinyItemNotFound. Vault items
 * work from any character; a character-held item works only from its owner. So
 * we catch each per-character throw and try the next; we rethrow only if every
 * character rejects the write.
 */
export async function setLock(item: GhostItem, characterId: string, locked: boolean): Promise<void> {
  const inv = await getInventory();
  const membershipType = inv.membership.membershipType;
  // Ordered candidate characters: the caller's first, then the rest.
  const candidates = [characterId, ...inv.characters.map((c) => c.characterId).filter((c) => c !== characterId)];

  const failures: string[] = [];
  for (const cid of candidates) {
    try {
      await setItemLockState(authedHttp, {
        state: locked,
        itemId: item.itemInstanceId!,
        characterId: cid,
        membershipType,
      });
      patchLockState(item.itemInstanceId!, locked);
      return;
    } catch (e) {
      failures.push(`char ${cid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(
    `Failed to ${locked ? 'lock' : 'unlock'} ${item.name} (${item.itemInstanceId}): ${failures.join('; ')}`,
  );
}

/** Pull an item out of the postmaster onto its character (needs room). */
export async function pullPostmaster(item: GhostItem, characterId: string): Promise<void> {
  await pullFromPostmaster(authedHttp, {
    itemReferenceHash: item.itemHash,
    stackSize: 1,
    itemId: item.itemInstanceId!,
    characterId,
    membershipType: (await getInventory()).membership.membershipType,
  });
  invalidateInventory();
}
