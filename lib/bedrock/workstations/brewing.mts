/**
 * Brewing Stand Workstation - Potion brewing operations for Bedrock protocol
 *
 * Container IDs from packet captures:
 * - brewing_input: slot 0 (ingredient like nether wart, sugar)
 * - brewing_result: slots 1, 2, 3 (three potion bottle slots)
 * - brewing_fuel: slot 4 (blaze powder)
 *
 * Pattern: Place items → server auto-brews (no craft action needed)
 * Similar to furnace - just place items and wait.
 */

import type { Item } from 'prismarine-item';
import type { Block } from 'prismarine-block';
import type { Window } from 'prismarine-windows';
import type { BedrockBot } from '../../../index.js';
import { actions, getNextItemStackRequestId, getStackId, sendRequest, waitForResponse, ContainerIds } from '../item-stack-actions.mts';
import { findItemInAllSlots } from '../crafting-core.mts';
import { twoStepTransfer } from '../container.mts';

// ============================================================================
// Constants
// ============================================================================

export const BrewingSlots = {
  INGREDIENT: 0,
  RESULT_1: 1,
  RESULT_2: 2,
  RESULT_3: 3,
  FUEL: 4,
} as const;

// ============================================================================
// Brewing Stand Interface
// ============================================================================

export interface BrewingStand {
  window: Window;
  /** Put blaze powder as fuel */
  putFuel: (count: number) => Promise<void>;
  /** Put ingredient (nether wart, sugar, etc.) */
  putIngredient: (itemType: number | string, metadata: number | null) => Promise<void>;
  /** Put potion bottle in result slot (1-3) */
  putBottle: (slot: 1 | 2 | 3, itemType: number | string, metadata: number | null) => Promise<void>;
  /** Take bottle from result slot (1-3) */
  takeBottle: (slot: 1 | 2 | 3) => Promise<Item | null>;
  /** Get fuel item */
  fuelItem: () => Item | null;
  /** Get ingredient item */
  ingredientItem: () => Item | null;
  /** Get bottle in slot (1-3) */
  bottleItem: (slot: 1 | 2 | 3) => Item | null;
  /** Fuel remaining (0-1) */
  fuel: number;
  /** Brewing progress (0-1) */
  progress: number;
  /** Close the brewing stand */
  close: () => void;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Open a brewing stand block and return interface for brewing
 */
export async function openBrewingStand(bot: BedrockBot, brewingBlock: Block): Promise<BrewingStand> {
  const window = await bot.openBlock(brewingBlock);
  bot.logger.debug(`Opened brewing stand window: ${window?.id}`);

  // Track fuel and progress from container_set_data packet
  let fuelProgress = 0;
  let brewProgress = 0;

  // Listen for container data updates (brewing progress)
  const dataHandler = (packet: any) => {
    if (packet.window_id !== window.id) return;

    // Property 0 = brewing time remaining
    // Property 1 = fuel amount
    if (packet.property === 0) {
      // Brewing progress - 400 ticks = full brew
      brewProgress = Math.min(1, 1 - (packet.value / 400));
    } else if (packet.property === 1) {
      // Fuel - 20 is full
      fuelProgress = packet.value / 20;
    }
  };
  bot._client.on('container_set_data', dataHandler);

  const brewing: BrewingStand = {
    window,

    get fuel() { return fuelProgress; },
    get progress() { return brewProgress; },

    async putFuel(count: number): Promise<void> {
      const foundItem = findItemInAllSlots(bot, 'blaze_powder', null);
      if (!foundItem) {
        throw new Error('Blaze powder not found in inventory');
      }

      const slotIndex = foundItem.slot;
      const stackId = getStackId(foundItem);
      const requestId = getNextItemStackRequestId();

      sendRequest(
        bot,
        requestId,
        actions()
          .place(count, { containerId: ContainerIds.HOTBAR_AND_INVENTORY, slot: slotIndex, stackId }, { containerId: ContainerIds.BREWING_FUEL, slot: BrewingSlots.FUEL, stackId: 0 })
          .build()
      );

      if (!(await waitForResponse(bot, requestId))) {
        throw new Error('Failed to put fuel in brewing stand');
      }
    },

    async putIngredient(itemType: number | string, metadata: number | null): Promise<void> {
      const foundItem = findItemInAllSlots(bot, itemType, metadata);
      if (!foundItem) {
        throw new Error(`Ingredient ${itemType} not found in inventory`);
      }

      const slotIndex = foundItem.slot;
      const stackId = getStackId(foundItem);
      const requestId = getNextItemStackRequestId();

      sendRequest(
        bot,
        requestId,
        actions()
          .place(1, { containerId: ContainerIds.HOTBAR_AND_INVENTORY, slot: slotIndex, stackId }, { containerId: ContainerIds.BREWING_INPUT, slot: BrewingSlots.INGREDIENT, stackId: 0 })
          .build()
      );

      if (!(await waitForResponse(bot, requestId))) {
        throw new Error('Failed to put ingredient in brewing stand');
      }
    },

    async putBottle(slot: 1 | 2 | 3, itemType: number | string, metadata: number | null): Promise<void> {
      const foundItem = findItemInAllSlots(bot, itemType, metadata);
      if (!foundItem) {
        throw new Error(`Potion/bottle ${itemType} not found in inventory`);
      }

      const slotIndex = foundItem.slot;
      const stackId = getStackId(foundItem);
      const targetSlot = slot; // slots 1, 2, 3 map directly
      const requestId = getNextItemStackRequestId();

      sendRequest(
        bot,
        requestId,
        actions()
          .place(1, { containerId: ContainerIds.HOTBAR_AND_INVENTORY, slot: slotIndex, stackId }, { containerId: ContainerIds.BREWING_RESULT, slot: targetSlot, stackId: 0 })
          .build()
      );

      if (!(await waitForResponse(bot, requestId))) {
        throw new Error(`Failed to put bottle in brewing stand slot ${slot}`);
      }
    },

    async takeBottle(slot: 1 | 2 | 3): Promise<Item | null> {
      const targetSlot = slot; // slots 1, 2, 3 map directly
      const item = window.slots[targetSlot];
      if (!item) return null;

      const stackId = getStackId(item);
      const requestId = getNextItemStackRequestId();

      sendRequest(
        bot,
        requestId,
        actions()
          .takeToCursor(1, { containerId: ContainerIds.BREWING_RESULT, slot: targetSlot, stackId })
          .build()
      );

      if (!(await waitForResponse(bot, requestId))) {
        throw new Error(`Failed to take bottle from brewing stand slot ${slot}`);
      }

      await bot.putAway(0);
      return item;
    },

    fuelItem(): Item | null {
      return window.slots[BrewingSlots.FUEL] || null;
    },

    ingredientItem(): Item | null {
      return window.slots[BrewingSlots.INGREDIENT] || null;
    },

    bottleItem(slot: 1 | 2 | 3): Item | null {
      return window.slots[slot] || null;
    },

    close() {
      bot._client.removeListener('container_set_data', dataHandler);
      bot.closeWindow(window);
    },
  };

  return brewing;
}
