/**
 * Enchanting Table Workstation - Enchanting operations for Bedrock protocol
 *
 * Container IDs from packet captures:
 * - enchanting_input: slot 14
 * - enchanting_lapis: slot 15
 */

import type { Item } from 'prismarine-item';
import type { Block } from 'prismarine-block';
import type { Window } from 'prismarine-windows';
import type { BedrockBot } from '../../../index.js';
import { actions, getNextItemStackRequestId, getStackId, sendRequest, waitForResponse, ContainerIds } from '../item-stack-actions.mts';
import { findItemInAllSlots, CraftingSlots } from '../crafting-core.mts';

// ============================================================================
// Constants
// ============================================================================

export const EnchantingSlots = {
  INPUT: 14,
  LAPIS: 15,
} as const;

// ============================================================================
// Enchantment Table Interface
// ============================================================================

export interface EnchantmentTable {
  window: Window;
  /** Enchant item. enchantSlot is 0-2 for the three enchant options */
  enchant: (enchantSlot: number) => Promise<void>;
  /** Put item to enchant */
  putItem: (itemType: number | string, metadata: number | null) => Promise<void>;
  /** Put lapis lazuli */
  putLapis: (count: number) => Promise<void>;
  /** Take enchanted item back */
  takeItem: () => Promise<Item | null>;
  /** Close the enchanting table */
  close: () => void;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Open an enchanting table and return interface for enchanting
 */
export async function openEnchantmentTable(bot: BedrockBot, enchantTableBlock: Block): Promise<EnchantmentTable> {
  const window = await bot.openBlock(enchantTableBlock);
  bot.logger.debug(`Opened enchanting table window: ${window?.id}`);

  // Track enchant options from server
  let enchantOptions: any[] = [];
  let inputStackId = 0;
  let lapisStackId = 0;
  let inputItemInfo: { network_id: number; count: number; metadata: number; block_runtime_id: number; extra: any } | null = null;

  // Listen for enchant options from server
  const optionsHandler = (packet: any) => {
    enchantOptions = packet.options || [];
    bot.logger.debug(`Received ${enchantOptions.length} enchant options`);
  };
  bot._client.on('player_enchant_options', optionsHandler);

  return {
    window,

    /**
     * Get available enchantment options
     */
    getOptions(): any[] {
      return enchantOptions;
    },

    /**
     * Enchant item using the option at the given index (0-2)
     * The enchantSlot must be an option_id from player_enchant_options packet
     *
     * Pattern from packet captures (verified working):
     * 1. craft_recipe(recipeNetworkId) + results_deprecated
     * 2. consume(enchanting_input:14)
     * 3. place(creative_output → enchanting_input:14) - result goes BACK to input slot
     * 4. consume(enchanting_lapis:15) - lapis consumed AFTER placing result
     */
    async enchant(enchantSlot: number): Promise<void> {
      // If we have options, use the option_id from the options list
      // The option_id is received as zigzag32, but recipe_network_id needs the unsigned encoding
      // zigzag encode: (n << 1) ^ (n >> 31) for 32-bit
      let optionId = enchantSlot;
      if (enchantOptions.length > 0) {
        if (enchantSlot >= 0 && enchantSlot < enchantOptions.length) {
          const rawOptionId = enchantOptions[enchantSlot].option_id;
          // Convert zigzag-decoded value back to unsigned varint: zigzag encode
          optionId = (rawOptionId << 1) ^ (rawOptionId >> 31);
          bot.logger.debug(`Using enchant option ${enchantSlot}: rawOptionId=${rawOptionId}, encoded=${optionId}`);
        } else {
          throw new Error(`Invalid enchant slot ${enchantSlot}, only ${enchantOptions.length} options available`);
        }
      }

      // Get the lapis cost from enchant options (defaults to 1 for level 1)
      const lapisCost = enchantOptions.length > 0 ? (enchantOptions[enchantSlot].cost || 1) : 1;

      const requestId = getNextItemStackRequestId();

      // Pattern from packet captures:
      // craft_recipe + results_deprecated + consume(input) + place(output→input) + consume(lapis)
      // Include the input item as result (required to prevent server crash)
      const resultItems = inputItemInfo ? [{
        network_id: inputItemInfo.network_id,
        count: inputItemInfo.count,
        metadata: inputItemInfo.metadata,
        block_runtime_id: inputItemInfo.block_runtime_id,
        extra: inputItemInfo.extra,
      }] : [];

      const actionList: any[] = [
        {
          type_id: 'craft_recipe',
          recipe_network_id: optionId, // Use option_id from enchant options
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
            slot_type: { container_id: ContainerIds.ENCHANTING_INPUT },
            slot: EnchantingSlots.INPUT,
            stack_id: inputStackId,
          },
        },
        {
          // Result placed BACK to enchanting_input slot (key pattern!)
          type_id: 'place',
          count: 1,
          source: {
            slot_type: { container_id: ContainerIds.CREATIVE_OUTPUT },
            slot: CraftingSlots.CREATIVE_OUTPUT_SLOT,
            stack_id: requestId, // Use -requestId as source stack
          },
          destination: {
            slot_type: { container_id: ContainerIds.ENCHANTING_INPUT },
            slot: EnchantingSlots.INPUT,
            stack_id: requestId, // Use -requestId as dest stack (same as source)
          },
        },
        {
          // Consume lapis AFTER placing result back
          type_id: 'consume',
          count: lapisCost,
          source: {
            slot_type: { container_id: ContainerIds.ENCHANTING_LAPIS },
            slot: EnchantingSlots.LAPIS,
            stack_id: lapisStackId,
          },
        },
      ];

      bot.logger.debug(`Enchanting: optionId=${optionId}, inputStackId=${inputStackId}, lapisStackId=${lapisStackId}, lapisCost=${lapisCost}`);

      // Capture the new stackId from the response
      const captureHandler = (packet: any) => {
        for (const resp of packet.responses || []) {
          if (resp.request_id === requestId && resp.status === 'ok') {
            for (const container of resp.containers || []) {
              if (container.slot_type?.container_id === 'enchanting_input') {
                for (const slot of container.slots || []) {
                  if (slot.slot === EnchantingSlots.INPUT && slot.item_stack_id > 0) {
                    inputStackId = slot.item_stack_id;
                    bot.logger.debug(`Captured enchanted item stackId: ${inputStackId}`);
                  }
                }
              }
            }
          }
        }
      };
      bot._client.once('item_stack_response', captureHandler);

      sendRequest(bot, requestId, actionList);

      if (!(await waitForResponse(bot, requestId))) {
        bot._client.removeListener('item_stack_response', captureHandler);
        throw new Error('Enchanting failed');
      }

      // Clear options after enchanting
      enchantOptions = [];
    },

    async putItem(itemType: number | string, metadata: number | null): Promise<void> {
      const foundItem = findItemInAllSlots(bot, itemType, metadata);
      if (!foundItem) {
        throw new Error(`Item ${itemType} not found in inventory`);
      }

      // Store item info for results_deprecated - ItemLegacy format
      // network_id of 0 means empty slot (void), so we only need network_id for non-empty
      inputItemInfo = {
        network_id: (foundItem as any).nid ?? foundItem.type,
        count: 1,
        metadata: foundItem.metadata ?? 0,
        block_runtime_id: 0,
        extra: { has_nbt: 0, can_place_on: [], can_destroy: [] },
      };
      bot.logger.debug(`Stored input item info: network_id=${inputItemInfo.network_id}`);

      const slotIndex = foundItem.slot;
      const stackId = getStackId(foundItem);
      const requestId = getNextItemStackRequestId();

      // Use take + place through cursor like real client
      // Step 1: Take item to cursor
      const takeRequestId = requestId;
      sendRequest(
        bot,
        takeRequestId,
        actions()
          .takeToCursor(1, { containerId: ContainerIds.HOTBAR_AND_INVENTORY, slot: slotIndex, stackId })
          .build()
      );

      if (!(await waitForResponse(bot, takeRequestId))) {
        throw new Error('Failed to take item to cursor');
      }

      // Step 2: Place from cursor to enchanting_input
      const placeRequestId = getNextItemStackRequestId();
      let capturedStackId = stackId;
      const captureHandler = (packet: any) => {
        for (const resp of packet.responses || []) {
          if (resp.request_id === placeRequestId && resp.status === 'ok') {
            for (const container of resp.containers || []) {
              if (container.slot_type?.container_id === 'enchanting_input') {
                for (const slot of container.slots || []) {
                  if (slot.slot === EnchantingSlots.INPUT && slot.item_stack_id > 0) {
                    capturedStackId = slot.item_stack_id;
                  }
                }
              }
            }
          }
        }
      };
      bot._client.once('item_stack_response', captureHandler);

      sendRequest(
        bot,
        placeRequestId,
        actions()
          .place(1, { containerId: ContainerIds.CURSOR, slot: 0, stackId }, { containerId: ContainerIds.ENCHANTING_INPUT, slot: EnchantingSlots.INPUT, stackId: 0 })
          .build()
      );

      if (!(await waitForResponse(bot, placeRequestId))) {
        bot._client.removeListener('item_stack_response', captureHandler);
        throw new Error('Failed to put item in enchanting table');
      }

      inputStackId = capturedStackId;
      bot.logger.debug(`Enchanting input stackId: ${inputStackId}`);

      // Wait a bit for server to send enchant options
      await new Promise(r => setTimeout(r, 300));
    },

    async putLapis(count: number): Promise<void> {
      const foundItem = findItemInAllSlots(bot, 'lapis_lazuli', null);
      if (!foundItem) {
        throw new Error('Lapis lazuli not found in inventory');
      }

      const slotIndex = foundItem.slot;
      const stackId = getStackId(foundItem);
      const totalCount = foundItem.count;
      const requestId = getNextItemStackRequestId();

      // Use take + place through cursor like real client
      // Step 1: Take lapis to cursor (take all)
      sendRequest(
        bot,
        requestId,
        actions()
          .takeToCursor(totalCount, { containerId: ContainerIds.HOTBAR_AND_INVENTORY, slot: slotIndex, stackId })
          .build()
      );

      if (!(await waitForResponse(bot, requestId))) {
        throw new Error('Failed to take lapis to cursor');
      }

      // Step 2: Place count lapis from cursor to enchanting_lapis
      const placeRequestId = getNextItemStackRequestId();
      let capturedStackId = stackId;
      const captureHandler = (packet: any) => {
        for (const resp of packet.responses || []) {
          if (resp.request_id === placeRequestId && resp.status === 'ok') {
            for (const container of resp.containers || []) {
              if (container.slot_type?.container_id === 'enchanting_lapis') {
                for (const slot of container.slots || []) {
                  if (slot.slot === EnchantingSlots.LAPIS && slot.item_stack_id > 0) {
                    capturedStackId = slot.item_stack_id;
                  }
                }
              }
            }
          }
        }
      };
      bot._client.once('item_stack_response', captureHandler);

      sendRequest(
        bot,
        placeRequestId,
        actions()
          .place(count, { containerId: ContainerIds.CURSOR, slot: 0, stackId }, { containerId: ContainerIds.ENCHANTING_LAPIS, slot: EnchantingSlots.LAPIS, stackId: 0 })
          .build()
      );

      if (!(await waitForResponse(bot, placeRequestId))) {
        bot._client.removeListener('item_stack_response', captureHandler);
        throw new Error('Failed to put lapis in enchanting table');
      }

      lapisStackId = capturedStackId;
      bot.logger.debug(`Enchanting lapis stackId: ${lapisStackId}`);

      // If we had more lapis than needed, put the rest back
      if (totalCount > count) {
        const putBackRequestId = getNextItemStackRequestId();
        sendRequest(
          bot,
          putBackRequestId,
          actions()
            .place(totalCount - count, { containerId: ContainerIds.CURSOR, slot: 0, stackId }, { containerId: ContainerIds.HOTBAR_AND_INVENTORY, slot: slotIndex, stackId: 0 })
            .build()
        );
        await waitForResponse(bot, putBackRequestId);
      }
    },

    async takeItem(): Promise<Item | null> {
      const requestId = getNextItemStackRequestId();

      // Use the captured stackId from enchanting response
      sendRequest(bot, requestId, actions().takeToCursor(1, { containerId: ContainerIds.ENCHANTING_INPUT, slot: EnchantingSlots.INPUT, stackId: inputStackId }).build());

      if (!(await waitForResponse(bot, requestId))) {
        return null;
      }

      await bot.putAway(0);
      return null; // Would need to track the item
    },

    close() {
      bot._client.removeListener('player_enchant_options', optionsHandler);
      bot.closeWindow(window);
    },
  };
}
