/**
 * Cartography Table Workstation - Map operations for Bedrock protocol
 *
 * Container IDs from packet captures:
 * - cartography_input: slot 12 (main map)
 * - cartography_additional: slot 13 (paper/empty map/glass pane)
 *
 * Pattern from captures:
 * optional + consume(cartography_input:12) + consume(cartography_additional:13) +
 * take(creative_output → cursor)
 *
 * Operations:
 * - Clone map: map + empty_map → 2 identical maps
 * - Extend map: map + paper → larger map
 * - Lock map: map + glass_pane → locked (non-updating) map
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

export const CartographySlots = {
  INPUT: 12,
  ADDITIONAL: 13,
} as const;

// ============================================================================
// Cartography Table Interface
// ============================================================================

export interface CartographyTable {
  window: Window;
  /** Put map in input slot */
  putMap: (itemType: number | string, metadata: number | null) => Promise<void>;
  /** Put paper in additional slot (for extending) */
  putPaper: () => Promise<void>;
  /** Put empty map in additional slot (for cloning) */
  putEmptyMap: () => Promise<void>;
  /** Put glass pane in additional slot (for locking) */
  putGlassPane: () => Promise<void>;
  /** Execute the cartography operation (clone/extend/lock) */
  craft: () => Promise<void>;
  /** Take result from cartography table */
  takeResult: () => Promise<Item | null>;
  /** Get current map item */
  mapItem: () => Item | null;
  /** Get current additional item */
  additionalItem: () => Item | null;
  /** Close the cartography table */
  close: () => void;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Open a cartography table block and return interface for map operations
 */
export async function openCartographyTable(bot: BedrockBot, cartographyBlock: Block): Promise<CartographyTable> {
  const window = await bot.openBlock(cartographyBlock);
  bot.logger.debug(`Opened cartography table window: ${window?.id}`);

  // Track stack IDs of placed items
  let mapStackId = 0;
  let additionalStackId = 0;

  async function putItem(containerId: string, slot: number, itemType: number | string, metadata: number | null): Promise<number> {
    const foundItem = findItemInAllSlots(bot, itemType, metadata);
    if (!foundItem) {
      throw new Error(`Item ${itemType} not found in inventory`);
    }

    const slotIndex = foundItem.slot;
    const stackId = getStackId(foundItem);

    const result = await twoStepTransfer(
      bot,
      { containerId: ContainerIds.HOTBAR_AND_INVENTORY, slot: slotIndex, stackId },
      { containerId, slot, stackId: 0 },
      1
    );

    if (!result.success) {
      throw new Error(`Failed to place ${itemType} in cartography table`);
    }

    return result.cursorStackId;
  }

  return {
    window,

    async putMap(itemType: number | string, metadata: number | null): Promise<void> {
      mapStackId = await putItem(ContainerIds.CARTOGRAPHY_INPUT, CartographySlots.INPUT, itemType, metadata);
    },

    async putPaper(): Promise<void> {
      additionalStackId = await putItem(ContainerIds.CARTOGRAPHY_ADDITIONAL, CartographySlots.ADDITIONAL, 'paper', null);
    },

    async putEmptyMap(): Promise<void> {
      additionalStackId = await putItem(ContainerIds.CARTOGRAPHY_ADDITIONAL, CartographySlots.ADDITIONAL, 'empty_map', null);
    },

    async putGlassPane(): Promise<void> {
      additionalStackId = await putItem(ContainerIds.CARTOGRAPHY_ADDITIONAL, CartographySlots.ADDITIONAL, 'glass_pane', null);
    },

    async craft(): Promise<void> {
      // Get current stack IDs from window slots
      const mapItem = window.slots[CartographySlots.INPUT];
      const addItem = window.slots[CartographySlots.ADDITIONAL];

      if (!mapItem || !addItem) {
        throw new Error('Map and additional item required in cartography table');
      }

      const currentMapStackId = getStackId(mapItem) || mapStackId;
      const currentAdditionalStackId = getStackId(addItem) || additionalStackId;

      // Need to wait a bit for server to register the placed items
      await new Promise((r) => setTimeout(r, 200));

      const requestId = getNextItemStackRequestId();

      // Pattern from packet captures:
      // optional + consume(input) + consume(additional) + take(output)
      // Note: Cartography uses 'optional' instead of craft_recipe
      const actionList: any[] = [
        {
          type_id: 'optional',
          filtered_string_index: 0,
        },
        {
          type_id: 'consume',
          count: 1,
          source: {
            slot_type: { container_id: ContainerIds.CARTOGRAPHY_INPUT },
            slot: CartographySlots.INPUT,
            stack_id: currentMapStackId,
          },
        },
        {
          type_id: 'consume',
          count: 1,
          source: {
            slot_type: { container_id: ContainerIds.CARTOGRAPHY_ADDITIONAL },
            slot: CartographySlots.ADDITIONAL,
            stack_id: currentAdditionalStackId,
          },
        },
        {
          type_id: 'take',
          count: 2, // Clone produces 2 maps
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

      bot.logger.debug(`Cartography craft: mapStackId=${currentMapStackId}, additionalStackId=${currentAdditionalStackId}`);
      sendRequest(bot, requestId, actionList);

      if (!(await waitForResponse(bot, requestId))) {
        throw new Error('Cartography table craft failed');
      }

      // Put result away from cursor
      await bot.putAway(0);
    },

    async takeResult(): Promise<Item | null> {
      // Result is already in cursor after craft, just put away
      await bot.putAway(0);
      return null;
    },

    mapItem(): Item | null {
      return window.slots[CartographySlots.INPUT] || null;
    },

    additionalItem(): Item | null {
      return window.slots[CartographySlots.ADDITIONAL] || null;
    },

    close() {
      bot.closeWindow(window);
    },
  };
}
