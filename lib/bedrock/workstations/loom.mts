/**
 * Loom Workstation - Banner pattern operations for Bedrock protocol
 *
 * Container IDs from packet captures:
 * - loom_input: slot 9 (banner)
 * - loom_dye: slot 10 (dye)
 *
 * Pattern from captures (NO recipeNetworkId!):
 * craft_loom_request(timesCrafted) + results_deprecated +
 * consume(loom_input:9) + consume(loom_dye:10) + take(creative_output → cursor)
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

export const LoomSlots = {
  BANNER: 9,
  DYE: 10,
} as const;

// ============================================================================
// Loom Interface
// ============================================================================

export interface Loom {
  window: Window;
  /** Put banner in input slot */
  putBanner: (itemType: number | string, metadata: number | null) => Promise<void>;
  /** Put dye in dye slot */
  putDye: (itemType: number | string, metadata: number | null) => Promise<void>;
  /** Apply pattern to banner (pattern selection is done via UI, this just confirms) */
  applyPattern: () => Promise<void>;
  /** Take result from loom */
  takeResult: () => Promise<Item | null>;
  /** Get current banner item */
  bannerItem: () => Item | null;
  /** Get current dye item */
  dyeItem: () => Item | null;
  /** Close the loom */
  close: () => void;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Open a loom block and return interface for banner patterns
 */
export async function openLoom(bot: BedrockBot, loomBlock: Block): Promise<Loom> {
  const window = await bot.openBlock(loomBlock);
  bot.logger.debug(`Opened loom window: ${window?.id}`);

  // Track stack IDs of placed items
  let bannerStackId = 0;
  let dyeStackId = 0;

  return {
    window,

    async putBanner(itemType: number | string, metadata: number | null): Promise<void> {
      const foundItem = findItemInAllSlots(bot, itemType, metadata);
      if (!foundItem) {
        throw new Error(`Banner ${itemType} not found in inventory`);
      }

      const slotIndex = foundItem.slot;
      const stackId = getStackId(foundItem);

      const result = await twoStepTransfer(
        bot,
        { containerId: ContainerIds.HOTBAR_AND_INVENTORY, slot: slotIndex, stackId },
        { containerId: ContainerIds.LOOM_INPUT, slot: LoomSlots.BANNER, stackId: 0 },
        1
      );

      if (!result.success) {
        throw new Error('Failed to place banner in loom');
      }

      bannerStackId = result.cursorStackId;
    },

    async putDye(itemType: number | string, metadata: number | null): Promise<void> {
      const foundItem = findItemInAllSlots(bot, itemType, metadata);
      if (!foundItem) {
        throw new Error(`Dye ${itemType} not found in inventory`);
      }

      const slotIndex = foundItem.slot;
      const stackId = getStackId(foundItem);

      const result = await twoStepTransfer(
        bot,
        { containerId: ContainerIds.HOTBAR_AND_INVENTORY, slot: slotIndex, stackId },
        { containerId: ContainerIds.LOOM_DYE, slot: LoomSlots.DYE, stackId: 0 },
        1
      );

      if (!result.success) {
        throw new Error('Failed to place dye in loom');
      }

      dyeStackId = result.cursorStackId;
    },

    async applyPattern(): Promise<void> {
      // Get current stack IDs from window slots
      const bannerItem = window.slots[LoomSlots.BANNER];
      const dyeItem = window.slots[LoomSlots.DYE];

      if (!bannerItem || !dyeItem) {
        throw new Error('Banner and dye required in loom');
      }

      const currentBannerStackId = getStackId(bannerItem) || bannerStackId;
      const currentDyeStackId = getStackId(dyeItem) || dyeStackId;

      // Need to wait a bit for server to register the placed items
      await new Promise((r) => setTimeout(r, 200));

      const requestId = getNextItemStackRequestId();

      // Pattern from packet captures:
      // craft_loom_request (NO recipe_network_id!) + results_deprecated + 2x consume + take
      const actionList: any[] = [
        {
          type_id: 'craft_loom_request',
          times_crafted: 1,
          // Note: Loom does NOT have recipe_network_id, pattern is selected via UI
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
            slot_type: { container_id: ContainerIds.LOOM_INPUT },
            slot: LoomSlots.BANNER,
            stack_id: currentBannerStackId,
          },
        },
        {
          type_id: 'consume',
          count: 1,
          source: {
            slot_type: { container_id: ContainerIds.LOOM_DYE },
            slot: LoomSlots.DYE,
            stack_id: currentDyeStackId,
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

      bot.logger.debug(`Loom apply pattern: bannerStackId=${currentBannerStackId}, dyeStackId=${currentDyeStackId}`);
      sendRequest(bot, requestId, actionList);

      if (!(await waitForResponse(bot, requestId))) {
        throw new Error('Loom pattern application failed');
      }

      // Put result away from cursor
      await bot.putAway(0);
    },

    async takeResult(): Promise<Item | null> {
      // Result is already in cursor after applyPattern, just put away
      await bot.putAway(0);
      return null;
    },

    bannerItem(): Item | null {
      return window.slots[LoomSlots.BANNER] || null;
    },

    dyeItem(): Item | null {
      return window.slots[LoomSlots.DYE] || null;
    },

    close() {
      bot.closeWindow(window);
    },
  };
}
