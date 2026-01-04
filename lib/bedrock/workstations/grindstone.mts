/**
 * Grindstone Workstation - Disenchanting operations for Bedrock protocol
 *
 * Container IDs from packet captures:
 * - grindstone_input: slot 16
 *
 * Pattern from captures:
 * craft_grindstone_request(recipeNetworkId) + results_deprecated +
 * consume(grindstone_input:16) + take(creative_output → cursor)
 */

import type { Item } from 'prismarine-item';
import type { Block } from 'prismarine-block';
import type { Window } from 'prismarine-windows';
import type { BedrockBot } from '../../../index.js';
import { actions, getNextItemStackRequestId, getStackId, sendRequest, waitForResponse, ContainerIds, cursor } from '../item-stack-actions.mts';
import { findItemInAllSlots, CraftingSlots } from '../crafting-core.mts';
import { twoStepTransfer } from '../container.mts';

// ============================================================================
// Constants
// ============================================================================

export const GrindstoneSlots = {
  INPUT: 16,
} as const;

// ============================================================================
// Grindstone Interface
// ============================================================================

export interface Grindstone {
  window: Window;
  /** Put enchanted item in input slot */
  putItem: (itemType: number | string, metadata: number | null) => Promise<void>;
  /** Disenchant the item (removes enchantments, returns XP) */
  disenchant: () => Promise<void>;
  /** Take result from grindstone */
  takeResult: () => Promise<Item | null>;
  /** Get current input item */
  inputItem: () => Item | null;
  /** Close the grindstone */
  close: () => void;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Open a grindstone block and return interface for disenchanting
 */
export async function openGrindstone(bot: BedrockBot, grindstoneBlock: Block): Promise<Grindstone> {
  const window = await bot.openBlock(grindstoneBlock);
  bot.logger.debug(`Opened grindstone window: ${window?.id}`);

  // Track stack ID of placed item
  let inputStackId = 0;

  return {
    window,

    async putItem(itemType: number | string, metadata: number | null): Promise<void> {
      const foundItem = findItemInAllSlots(bot, itemType, metadata);
      if (!foundItem) {
        throw new Error(`Item ${itemType} not found in inventory`);
      }

      const slotIndex = foundItem.slot;
      const stackId = getStackId(foundItem);

      // Use two-step transfer (via cursor) like stonecutter
      const result = await twoStepTransfer(
        bot,
        { containerId: ContainerIds.HOTBAR_AND_INVENTORY, slot: slotIndex, stackId },
        { containerId: ContainerIds.GRINDSTONE_INPUT, slot: GrindstoneSlots.INPUT, stackId: 0 },
        1
      );

      if (!result.success) {
        throw new Error('Failed to place item in grindstone');
      }

      // Track the stack ID for later disenchant
      inputStackId = result.cursorStackId;
    },

    async disenchant(): Promise<void> {
      // Get the current stack ID from window slot
      const inputItem = window.slots.find((s) => s != null);
      const currentStackId = inputItem ? getStackId(inputItem) : inputStackId;

      if (!inputItem) {
        throw new Error('No item in grindstone to disenchant');
      }

      // Need to wait a bit for server to register the placed item
      await new Promise((r) => setTimeout(r, 200));

      const requestId = getNextItemStackRequestId();

      // Pattern from packet captures:
      // craft_grindstone_request + results_deprecated + consume + take
      const actionList: any[] = [
        {
          type_id: 'craft_grindstone_request',
          // Grindstone uses a dynamic recipe ID based on the item
          // The server calculates it, we can use a placeholder
          recipe_network_id: 6117, // This is item-specific, may need adjustment
          times_crafted: 1,
        },
        {
          type_id: 'results_deprecated',
          result_items: [],
          times_crafted: 1,
        },
        {
          type_id: 'consume',
          count: 1,
          source: {
            slot_type: { container_id: ContainerIds.GRINDSTONE_INPUT },
            slot: GrindstoneSlots.INPUT,
            stack_id: currentStackId,
          },
        },
        {
          type_id: 'take',
          count: 1,
          source: {
            slot_type: { container_id: ContainerIds.CREATIVE_OUTPUT },
            slot: CraftingSlots.CREATIVE_OUTPUT_SLOT,
            stack_id: requestId,
          },
          destination: {
            slot_type: { container_id: ContainerIds.CURSOR },
            slot: 0,
            stack_id: 0,
          },
        },
      ];

      bot.logger.debug(`Grindstone disenchant: stackId=${currentStackId}`);
      sendRequest(bot, requestId, actionList);

      if (!(await waitForResponse(bot, requestId))) {
        throw new Error('Grindstone disenchant failed');
      }

      // Put result away from cursor
      await bot.putAway(0);
    },

    async takeResult(): Promise<Item | null> {
      // Result is already in cursor after disenchant, just put away
      await bot.putAway(0);
      return null;
    },

    inputItem(): Item | null {
      return window.slots[GrindstoneSlots.INPUT] || null;
    },

    close() {
      bot.closeWindow(window);
    },
  };
}
