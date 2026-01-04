/**
 * Smithing Table Workstation - Upgrade operations for Bedrock protocol
 *
 * Container IDs from packet captures:
 * - smithing_table_template: slot 53
 * - smithing_table_input: slot 51
 * - smithing_table_material: slot 52
 */

import type { Item as ItemType } from 'prismarine-item';
import type { Block } from 'prismarine-block';
import type { Window } from 'prismarine-windows';
import type { BedrockBot } from '../../../index.js';
import { actions, getNextItemStackRequestId, getStackId, sendRequest, waitForResponse, ContainerIds } from '../item-stack-actions.mts';
import { findItemInAllSlots, CraftingSlots } from '../crafting-core.mts';
import PItem from 'prismarine-item';

// ============================================================================
// Constants
// ============================================================================

export const SmithingSlots = {
  TEMPLATE: 53,
  INPUT: 51,
  MATERIAL: 52,
} as const;

// ============================================================================
// Smithing Table Interface
// ============================================================================

/** Result item info for smithing upgrade */
export interface SmithingResult {
  network_id: number;
  count?: number;
  metadata?: number;
  block_runtime_id?: number;
  extra?: { has_nbt: number; can_place_on: any[]; can_destroy: any[] };
}

export interface SmithingTable {
  window: Window;
  /** Upgrade item (e.g., diamond to netherite) - requires recipe network ID and result item info */
  upgrade: (recipeNetworkId: number, result: SmithingResult) => Promise<void>;
  /** Put template in template slot */
  putTemplate: (itemType: number | string, metadata: number | null) => Promise<void>;
  /** Put item to upgrade */
  putInput: (itemType: number | string, metadata: number | null) => Promise<void>;
  /** Put upgrade material */
  putMaterial: (itemType: number | string, metadata: number | null) => Promise<void>;
  /** Close the smithing table */
  close: () => void;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Open a smithing table and return interface for upgrades
 */
export async function openSmithingTable(bot: BedrockBot, smithingBlock: Block): Promise<SmithingTable> {
  const window = await bot.openBlock(smithingBlock);
  bot.logger.debug(`Opened smithing table window: ${window?.id}`);

  // Track stack IDs of items placed in smithing slots
  let templateStackId = 0;
  let inputStackId = 0;
  let materialStackId = 0;

  return {
    window,

    async upgrade(recipeNetworkId: number, result: SmithingResult): Promise<void> {
      // Get stack IDs from window slots (updated after putTemplate/putInput/putMaterial)
      const templateItem = window.slots[SmithingSlots.TEMPLATE];
      const inputItem = window.slots[SmithingSlots.INPUT];
      const materialItem = window.slots[SmithingSlots.MATERIAL];

      const tStackId = templateItem ? getStackId(templateItem) : templateStackId;
      const iStackId = inputItem ? getStackId(inputItem) : inputStackId;
      const mStackId = materialItem ? getStackId(materialItem) : materialStackId;

      const requestId = getNextItemStackRequestId();

      // Build result_items for results_deprecated (required by protocol)
      const resultItems = [{
        network_id: result.network_id,
        count: result.count ?? 1,
        metadata: result.metadata ?? 0,
        block_runtime_id: result.block_runtime_id ?? 0,
        extra: result.extra ?? { has_nbt: 0, can_place_on: [], can_destroy: [] },
      }];

      // Find an empty slot for output
      const emptySlot = bot.inventory.slots.findIndex(
        (s, i) => i >= bot.inventory.inventoryStart && i <= bot.inventory.inventoryEnd && !s
      );
      const destSlot = emptySlot !== -1 ? emptySlot : 0;

      // Based on packet capture: craft_recipe + results_deprecated + consume (all 3) + place
      // Use 'place' directly to inventory like stonecutter (not 'take' to cursor)
      const actionList: any[] = [
        {
          type_id: 'craft_recipe',
          recipe_network_id: recipeNetworkId,
          times_crafted: 1,
        },
        {
          type_id: 'results_deprecated',
          result_items: resultItems,
          times_crafted: 1,
        },
        {
          type_id: 'consume',
          count: 1,
          source: {
            slot_type: { container_id: ContainerIds.SMITHING_TABLE_TEMPLATE },
            slot: SmithingSlots.TEMPLATE,
            stack_id: tStackId,
          },
        },
        {
          type_id: 'consume',
          count: 1,
          source: {
            slot_type: { container_id: ContainerIds.SMITHING_TABLE_INPUT },
            slot: SmithingSlots.INPUT,
            stack_id: iStackId,
          },
        },
        {
          type_id: 'consume',
          count: 1,
          source: {
            slot_type: { container_id: ContainerIds.SMITHING_TABLE_MATERIAL },
            slot: SmithingSlots.MATERIAL,
            stack_id: mStackId,
          },
        },
        {
          type_id: 'place',
          count: 1,
          source: {
            slot_type: { container_id: ContainerIds.CREATIVE_OUTPUT },
            slot: CraftingSlots.CREATIVE_OUTPUT_SLOT,
            stack_id: requestId,
          },
          destination: {
            slot_type: { container_id: ContainerIds.HOTBAR_AND_INVENTORY },
            slot: destSlot,
            stack_id: 0,
          },
        },
      ];

      sendRequest(bot, requestId, actionList);

      if (!(await waitForResponse(bot, requestId))) {
        throw new Error('Smithing upgrade failed');
      }

      // item_stack_response only updates counts, not creates new items
      // Manually create the output item in the destination slot
      const Item = PItem(bot.registry);
      const newItem = new Item(result.network_id, result.count ?? 1, result.metadata ?? 0);
      (newItem as any).stackId = requestId; // Use request_id as stack_id
      bot.inventory.updateSlot(destSlot, newItem);
    },

    async putTemplate(itemType: number | string, metadata: number | null): Promise<void> {
      const foundItem = findItemInAllSlots(bot, itemType, metadata);
      if (!foundItem) {
        throw new Error(`Template ${itemType} not found in inventory`);
      }

      const slotIndex = foundItem.slot;
      const stackId = getStackId(foundItem);
      const requestId = getNextItemStackRequestId();

      sendRequest(
        bot,
        requestId,
        actions()
          .place(1, { containerId: ContainerIds.HOTBAR_AND_INVENTORY, slot: slotIndex, stackId }, { containerId: ContainerIds.SMITHING_TABLE_TEMPLATE, slot: SmithingSlots.TEMPLATE, stackId: 0 })
          .build()
      );

      if (!(await waitForResponse(bot, requestId))) {
        throw new Error('Failed to put template in smithing table');
      }

      // Track the stack ID for later use in upgrade
      templateStackId = stackId;
    },

    async putInput(itemType: number | string, metadata: number | null): Promise<void> {
      const foundItem = findItemInAllSlots(bot, itemType, metadata);
      if (!foundItem) {
        throw new Error(`Input item ${itemType} not found in inventory`);
      }

      const slotIndex = foundItem.slot;
      const stackId = getStackId(foundItem);
      const requestId = getNextItemStackRequestId();

      sendRequest(
        bot,
        requestId,
        actions()
          .place(1, { containerId: ContainerIds.HOTBAR_AND_INVENTORY, slot: slotIndex, stackId }, { containerId: ContainerIds.SMITHING_TABLE_INPUT, slot: SmithingSlots.INPUT, stackId: 0 })
          .build()
      );

      if (!(await waitForResponse(bot, requestId))) {
        throw new Error('Failed to put input in smithing table');
      }

      // Track the stack ID for later use in upgrade
      inputStackId = stackId;
    },

    async putMaterial(itemType: number | string, metadata: number | null): Promise<void> {
      const foundItem = findItemInAllSlots(bot, itemType, metadata);
      if (!foundItem) {
        throw new Error(`Material ${itemType} not found in inventory`);
      }

      const slotIndex = foundItem.slot;
      const stackId = getStackId(foundItem);
      const requestId = getNextItemStackRequestId();

      sendRequest(
        bot,
        requestId,
        actions()
          .place(1, { containerId: ContainerIds.HOTBAR_AND_INVENTORY, slot: slotIndex, stackId }, { containerId: ContainerIds.SMITHING_TABLE_MATERIAL, slot: SmithingSlots.MATERIAL, stackId: 0 })
          .build()
      );

      if (!(await waitForResponse(bot, requestId))) {
        throw new Error('Failed to put material in smithing table');
      }

      // Track the stack ID for later use in upgrade
      materialStackId = stackId;
    },

    close() {
      bot.closeWindow(window);
    },
  };
}
