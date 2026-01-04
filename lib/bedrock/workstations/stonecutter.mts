/**
 * Stonecutter Workstation - Stone crafting operations for Bedrock protocol
 *
 * Container IDs from packet captures:
 * - stonecutter_input: slot 3
 */

import type { Item } from 'prismarine-item';
import type { Block } from 'prismarine-block';
import type { Window } from 'prismarine-windows';
import type { BedrockBot } from '../../../index.js';
import { actions, getNextItemStackRequestId, getStackId, sendRequest, waitForResponse, ContainerIds } from '../item-stack-actions.mts';
import { CraftingSlots } from '../crafting-core.mts';
import { twoStepTransfer } from '../container.mts';

// ============================================================================
// Constants
// ============================================================================

export const StonecutterSlots = {
  INPUT: 3,
} as const;

// ============================================================================
// Stonecutter Interface
// ============================================================================

export interface Stonecutter {
  window: Window;
  /** Craft using stonecutter. recipeNetworkId is the recipe's network_id */
  craft: (recipeNetworkId: number, count?: number) => Promise<void>;
  /** Close the stonecutter */
  close: () => void;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Open a stonecutter block and return interface for crafting
 */
export async function openStonecutter(bot: BedrockBot, stonecutterBlock: Block): Promise<Stonecutter> {
  const window = await bot.openBlock(stonecutterBlock);
  bot.logger.debug(`Opened stonecutter window: ${window?.id}`);

  // Track the stack ID of items placed in stonecutter input
  let inputStackId = 0;

  return {
    window,

    async craft(recipeNetworkId: number, count: number = 1): Promise<void> {
      // Find stone-type item in inventory for initial placement
      const inputSlot = bot.inventory.slots.findIndex((s) => s && s.name?.includes('stone'));
      if (inputSlot === -1) {
        throw new Error('No stone item found in inventory for stonecutter');
      }

      const inputItem = bot.inventory.slots[inputSlot]!;
      const sourceStackId = getStackId(inputItem);

      // Transfer item to stonecutter using two-step cursor transfer
      const result = await twoStepTransfer(
        bot,
        { containerId: ContainerIds.HOTBAR_AND_INVENTORY, slot: inputSlot, stackId: sourceStackId },
        { containerId: ContainerIds.STONECUTTER_INPUT, slot: StonecutterSlots.INPUT, stackId: 0 },
        count
      );

      if (!result.success) {
        throw new Error('Failed to place item in stonecutter');
      }

      // The stackId of items in stonecutter is tracked from the cursor transfer
      inputStackId = result.cursorStackId;

      // Find an empty slot for output
      const emptySlot = bot.inventory.slots.findIndex((s, i) =>
        i >= bot.inventory.inventoryStart && i <= bot.inventory.inventoryEnd && !s
      );
      const destSlot = emptySlot !== -1 ? emptySlot : 0;

      // Need to wait a bit for server to register the placed item
      await new Promise((r) => setTimeout(r, 200));

      // Craft the item - use craft_recipe + consume + place pattern from packet captures
      const craftRequestId = getNextItemStackRequestId();

      // Debug: log window slots
      bot.logger.info(`Stonecutter window slots: ${JSON.stringify(window.slots.map((s) => s ? { name: s.name, count: s.count, stackId: getStackId(s) } : null))}`);

      // Get the updated stackId from the window slot (it may have been updated by the server)
      const stonecutterInputItem = window.slots.find((s) => s != null);
      const currentInputStackId = stonecutterInputItem ? getStackId(stonecutterInputItem) : inputStackId;

      bot.logger.info(`Stonecutter craft: recipeId=${recipeNetworkId}, inputStackId=${currentInputStackId} (tracked: ${inputStackId}), destSlot=${destSlot}`);

      const actionList: any[] = [
        {
          type_id: 'craft_recipe',
          recipe_network_id: recipeNetworkId,
          times_crafted: count,
        },
        {
          type_id: 'consume',
          count: count,
          source: {
            slot_type: { container_id: ContainerIds.STONECUTTER_INPUT },
            slot: StonecutterSlots.INPUT,
            stack_id: currentInputStackId,
          },
        },
        {
          type_id: 'place',
          count: count, // Stonecutter typically outputs 1:1 or 2:1
          source: {
            slot_type: { container_id: ContainerIds.CREATIVE_OUTPUT },
            slot: CraftingSlots.CREATIVE_OUTPUT_SLOT,
            stack_id: craftRequestId, // Use negative request ID as stack ID for crafted items
          },
          destination: {
            slot_type: { container_id: ContainerIds.HOTBAR_AND_INVENTORY },
            slot: destSlot,
            stack_id: 0,
          },
        },
      ];

      bot.logger.debug(`Stonecutter actions: ${JSON.stringify(actionList)}`);
      sendRequest(bot, craftRequestId, actionList);

      if (!(await waitForResponse(bot, craftRequestId))) {
        throw new Error('Stonecutter craft failed');
      }
    },

    close() {
      bot.closeWindow(window);
    },
  };
}
