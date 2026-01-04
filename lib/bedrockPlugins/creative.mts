/**
 * Creative Mode Plugin for Bedrock Edition
 *
 * Provides creative mode functionality:
 * - setInventorySlot: Pick items from creative inventory into player slots
 * - clearSlot: Remove item from a slot
 * - clearInventory: Clear all inventory slots
 * - flyTo: Fly to a destination in creative mode
 * - startFlying / stopFlying: Toggle creative flight
 *
 * Protocol:
 * - Items are picked using item_stack_request with craft_creative action
 * - Flow: craft_creative -> results_deprecated -> take to cursor -> place to slot
 * - creative_content packet provides available creative items
 */

import type { BedrockBot } from '../../index.js';
import type { Vec3 } from 'vec3';
import itemLoader, { type Item } from 'prismarine-item';
import { Vec3 as Vec3Constructor } from 'vec3';

import {
  getNextItemStackRequestId,
  getStackId,
  actions,
  sendRequest,
  waitForResponse,
  slot,
  cursor,
  fromPlayerSlot,
  ContainerIds,
} from '../bedrock/index.mts';

const CREATIVE_OUTPUT_SLOT = 50;
const FLYING_SPEED_PER_UPDATE = 0.5;

export default function inject(bot: BedrockBot) {
  const Item = (itemLoader as any)(bot.registry) as typeof Item;

  // Track creative items from creative_content packet
  // Maps network_id -> entry_id (for use in craft_creative action)
  let networkIdToEntryId: Map<number, number> = new Map();

  // Parse creative_content packet
  bot._client.on('creative_content', (packet: any) => {
    networkIdToEntryId.clear();

    if (packet.items) {
      for (const entry of packet.items) {
        const item = entry.item;
        if (item && item.network_id) {
          // Map network_id to entry_id for craft_creative lookup
          networkIdToEntryId.set(item.network_id, entry.entry_id);
        }
      }
      bot.logger.debug(`Creative content: ${packet.items.length} items indexed`);
    }
  });

  // Track pending slot updates to prevent duplicate requests
  const pendingSlotUpdates: Set<number> = new Set();

  /**
   * Set an inventory slot to a specific item (creative mode only)
   *
   * @param slotIndex - The slot index (0-44)
   * @param item - The item to set, or null to clear
   * @param waitTimeout - Timeout to wait for rejection (default 400ms)
   */
  async function setInventorySlot(slotIndex: number, item: Item | null, waitTimeout: number = 400): Promise<void> {
    if (slotIndex < 0 || slotIndex > 44) {
      throw new Error(`Invalid slot index: ${slotIndex}. Must be 0-44.`);
    }

    const currentItem = bot.inventory.slots[slotIndex];

    // If already same item, skip
    if (Item.equal(currentItem, item, true)) return;

    // Prevent concurrent updates to same slot
    if (pendingSlotUpdates.has(slotIndex)) {
      throw new Error(`Setting slot ${slotIndex} cancelled due to calling bot.creative.setInventorySlot(${slotIndex}, ...) again`);
    }

    pendingSlotUpdates.add(slotIndex);

    try {
      if (item === null) {
        // Clear the slot - destroy the item
        await clearSlotInternal(slotIndex);
      } else {
        // Set item in slot using creative pick
        await setSlotItem(slotIndex, item);
      }

      // Wait a bit to allow server to potentially reject
      if (waitTimeout > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTimeout));
      }
    } finally {
      pendingSlotUpdates.delete(slotIndex);
    }
  }

  /**
   * Internal: Clear a slot by destroying its contents
   */
  async function clearSlotInternal(slotIndex: number): Promise<void> {
    const item = bot.inventory.slots[slotIndex];
    if (!item) return;

    const loc = fromPlayerSlot(slotIndex, item);
    const requestId = getNextItemStackRequestId();

    sendRequest(bot, requestId, actions().destroy(item.count, loc).build());

    const success = await waitForResponse(bot, requestId);
    if (success) {
      bot.inventory.updateSlot(slotIndex, null);
    }
  }

  /**
   * Internal: Set item in slot using creative pick flow
   *
   * Protocol flow from packet capture:
   * 1. item_stack_request with:
   *    - craft_creative action
   *    - results_deprecated with the item
   *    - take from creative_output (slot 50) to cursor
   * 2. item_stack_request to place from cursor to destination
   */
  async function setSlotItem(slotIndex: number, item: Item): Promise<void> {
    // First clear the slot if it has an item
    const currentItem = bot.inventory.slots[slotIndex];
    if (currentItem) {
      await clearSlotInternal(slotIndex);
    }

    // Step 1: Pick item from creative inventory to cursor
    const pickRequestId = getNextItemStackRequestId();

    // Build the item in ItemLegacy format for results_deprecated
    const itemNotch = Item.toNotch(item, 0);
    const networkId = itemNotch.network_id;

    // Look up the creative entry_id for this item's network_id
    const entryId = networkIdToEntryId.get(networkId);
    if (entryId === undefined) {
      throw new Error(`Item ${item.name} (network_id=${networkId}) not found in creative inventory`);
    }

    const itemLegacy = {
      network_id: networkId,
      count: item.count,
      metadata: item.metadata || 0,
      stack_size: 64,
      block_runtime_id: itemNotch.block_runtime_id || 0,
      extra: { has_nbt: 0, can_place_on: [], can_destroy: [] },
    };

    // Send pick request: craft_creative + results_deprecated
    // Note: Protocol investigation needed - currently returns status 7 error
    const actionList = actions()
      .craftCreative(entryId)
      .resultsDeprecated([itemLegacy])
      .build();

    bot.logger.debug(`Creative pick: entryId=${entryId}, network_id=${networkId}, count=${item.count}`);

    sendRequest(bot, pickRequestId, actionList);

    const pickSuccess = await waitForResponse(bot, pickRequestId);
    if (!pickSuccess) {
      throw new Error('Failed to pick item from creative inventory');
    }

    // Small delay between requests (like real client)
    await new Promise((r) => setTimeout(r, 50));

    // Step 2: Place from cursor to destination slot
    const placeRequestId = getNextItemStackRequestId();
    const destLoc = fromPlayerSlot(slotIndex, null);

    // Use the negative request ID as stack ID (like real client does)
    const cursorStackId = pickRequestId;

    sendRequest(
      bot,
      placeRequestId,
      actions()
        .place(item.count, cursor(cursorStackId), slot(destLoc.containerId, destLoc.slot, 0))
        .build()
    );

    const placeSuccess = await waitForResponse(bot, placeRequestId);
    if (!placeSuccess) {
      throw new Error('Failed to place item from cursor to slot');
    }

    // Update local inventory state
    const newItem = new Item(item.type, item.count, item.metadata, item.nbt);
    newItem.slot = slotIndex;
    bot.inventory.updateSlot(slotIndex, newItem);
  }

  /**
   * Clear a specific slot
   */
  function clearSlot(slotIndex: number): Promise<void> {
    return setInventorySlot(slotIndex, null);
  }

  /**
   * Clear all inventory slots
   */
  async function clearInventory(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (let i = 0; i < bot.inventory.slots.length; i++) {
      const item = bot.inventory.slots[i];
      if (item) {
        promises.push(setInventorySlot(i, null));
      }
    }

    await Promise.all(promises);
  }

  // Flight state
  let normalGravity: number | null = null;

  /**
   * Fly to a destination (straight line, ensure clear path)
   */
  async function flyTo(destination: Vec3): Promise<void> {
    startFlying();

    let vector = destination.minus(bot.entity.position);
    let magnitude = vecMagnitude(vector);

    while (magnitude > FLYING_SPEED_PER_UPDATE) {
      bot.physics.gravity = 0;
      bot.entity.velocity = new Vec3Constructor(0, 0, 0);

      // Move in small steps
      const normalizedVector = vector.scaled(1 / magnitude);
      bot.entity.position.add(normalizedVector.scaled(FLYING_SPEED_PER_UPDATE));

      await sleep(50);

      vector = destination.minus(bot.entity.position);
      magnitude = vecMagnitude(vector);
    }

    // Final step
    bot.entity.position = destination;

    // Wait for move event
    await new Promise<void>((resolve) => {
      bot.once('move', resolve);
      // Don't wait forever if move doesn't fire
      setTimeout(resolve, 1000);
    });
  }

  /**
   * Start flying (disable gravity)
   */
  function startFlying(): void {
    if (normalGravity === null) {
      normalGravity = bot.physics.gravity;
    }
    bot.physics.gravity = 0;
  }

  /**
   * Stop flying (restore gravity)
   */
  function stopFlying(): void {
    if (normalGravity !== null) {
      bot.physics.gravity = normalGravity;
    }
  }

  // Expose creative API
  bot.creative = {
    setInventorySlot,
    clearSlot,
    clearInventory,
    flyTo,
    startFlying,
    stopFlying,
  };
}

// Utility functions
function vecMagnitude(vec: Vec3): number {
  return Math.sqrt(vec.x * vec.x + vec.y * vec.y + vec.z * vec.z);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
