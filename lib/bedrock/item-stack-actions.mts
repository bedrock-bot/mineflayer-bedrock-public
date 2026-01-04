/**
 * Item Stack Actions - Core action building utilities for Bedrock item_stack_request protocol
 *
 * This module provides:
 * - Stack ID helpers (replaces 50+ occurrences of `(item as any).stackId ?? 0`)
 * - Container ID constants
 * - SlotLocation type and helpers
 * - ActionBuilder class with fluent API
 * - Request ID management
 * - Request execution and response waiting
 */

import type { Item } from 'prismarine-item';
import type { BedrockBot } from '../../index.js';
import type { protocolTypes } from '../../bedrock-types.js';

// ============================================================================
// Stack ID Helpers
// ============================================================================

/**
 * Get stack ID from an item safely.
 * Replaces pattern: `(item as any).stackId ?? 0`
 */
export function getStackId(item: Item | null | undefined): number {
  return (item as any)?.stackId ?? 0;
}

/**
 * Set stack ID on an item.
 * Replaces pattern: `(item as any).stackId = value`
 */
export function setStackId(item: Item, stackId: number): void {
  (item as any).stackId = stackId;
}

// ============================================================================
// Container ID Constants
// ============================================================================

/**
 * Container IDs used in Bedrock item_stack_request protocol
 */
export const ContainerIds = {
  // Cursor
  CURSOR: 'cursor',

  // Player inventory sections
  HOTBAR: 'hotbar',
  INVENTORY: 'inventory',
  HOTBAR_AND_INVENTORY: 'hotbar_and_inventory',
  ARMOR: 'armor',
  OFFHAND: 'offhand',

  // External containers
  CONTAINER: 'container',

  // Crafting
  CRAFTING_INPUT: 'crafting_input',
  CREATIVE_OUTPUT: 'creative_output',
  CREATED_OUTPUT: 'created_output',

  // Furnace
  FURNACE_INGREDIENT: 'furnace_ingredient',
  FURNACE_FUEL: 'furnace_fuel',
  FURNACE_OUTPUT: 'furnace_output',

  // Enchanting
  ENCHANTING_INPUT: 'enchanting_input',
  ENCHANTING_LAPIS: 'enchanting_lapis',

  // Anvil
  ANVIL_INPUT: 'anvil_input',
  ANVIL_MATERIAL: 'anvil_material',

  // Stonecutter
  STONECUTTER_INPUT: 'stonecutter_input',

  // Smithing Table
  SMITHING_TABLE_TEMPLATE: 'smithing_table_template',
  SMITHING_TABLE_INPUT: 'smithing_table_input',
  SMITHING_TABLE_MATERIAL: 'smithing_table_material',

  // Brewing Stand
  BREWING_INPUT: 'brewing_input',
  BREWING_FUEL: 'brewing_fuel',
  BREWING_RESULT: 'brewing_result',

  // Grindstone
  GRINDSTONE_INPUT: 'grindstone_input',

  // Loom
  LOOM_INPUT: 'loom_input',
  LOOM_DYE: 'loom_dye',

  // Cartography Table
  CARTOGRAPHY_INPUT: 'cartography_input',
  CARTOGRAPHY_ADDITIONAL: 'cartography_additional',
} as const;

export type ContainerId = (typeof ContainerIds)[keyof typeof ContainerIds];

// ============================================================================
// Slot Location Type and Helpers
// ============================================================================

/**
 * Represents a slot location for item_stack_request actions
 */
export interface SlotLocation {
  containerId: string;
  slot: number;
  stackId: number;
  dynamicContainerId?: number;
}

/**
 * Create a cursor slot location
 */
export function cursor(stackId: number = 0): SlotLocation {
  return { containerId: ContainerIds.CURSOR, slot: 0, stackId };
}

/**
 * Create a slot location from container ID and slot index
 */
export function slot(containerId: string, slotIndex: number, stackId: number = 0, dynamicContainerId?: number): SlotLocation {
  return { containerId, slot: slotIndex, stackId, dynamicContainerId };
}

/**
 * Create a container slot location (for chests, etc.)
 */
export function containerSlot(slotIndex: number, stackId: number = 0): SlotLocation {
  return { containerId: ContainerIds.CONTAINER, slot: slotIndex, stackId };
}

/**
 * Create a hotbar_and_inventory slot location
 */
export function inventorySlot(slotIndex: number, stackId: number = 0): SlotLocation {
  return { containerId: ContainerIds.HOTBAR_AND_INVENTORY, slot: slotIndex, stackId };
}

/**
 * Create a SlotLocation from a player inventory slot index
 * Maps to correct container based on slot range:
 * - 0-8: hotbar
 * - 9-35: inventory
 * - 36-39: armor
 * - 45: offhand
 */
export function fromPlayerSlot(slotIndex: number, item?: Item | null): SlotLocation {
  const stackId = getStackId(item);

  if (slotIndex >= 0 && slotIndex <= 8) {
    return { containerId: ContainerIds.HOTBAR, slot: slotIndex, stackId };
  } else if (slotIndex >= 9 && slotIndex <= 35) {
    return { containerId: ContainerIds.INVENTORY, slot: slotIndex, stackId };
  } else if (slotIndex >= 36 && slotIndex <= 39) {
    return { containerId: ContainerIds.ARMOR, slot: slotIndex - 36, stackId };
  } else if (slotIndex === 45) {
    return { containerId: ContainerIds.OFFHAND, slot: 1, stackId };
  } else {
    throw new Error(`Invalid player inventory slot index: ${slotIndex}`);
  }
}

/**
 * Create a SlotLocation from an item (uses item.slot)
 */
export function fromItem(containerId: string, item: Item): SlotLocation {
  return {
    containerId,
    slot: item.slot,
    stackId: getStackId(item),
  };
}

// ============================================================================
// Action Types
// ============================================================================

type ItemStackAction = protocolTypes.ItemStackRequest['actions'][number];
type StackRequestSlotInfo = protocolTypes.StackRequestSlotInfo;
type RecipeIngredient = protocolTypes.RecipeIngredient;
type ItemLegacy = protocolTypes.ItemLegacy;

/**
 * Convert SlotLocation to StackRequestSlotInfo format
 */
function toSlotInfo(loc: SlotLocation): StackRequestSlotInfo {
  const slotType: { container_id: string; dynamic_container_id?: number } = {
    container_id: loc.containerId,
  };
  if (loc.dynamicContainerId !== undefined) {
    slotType.dynamic_container_id = loc.dynamicContainerId;
  }
  return {
    slot_type: slotType as any,
    slot: loc.slot,
    stack_id: loc.stackId,
  };
}

// ============================================================================
// Action Builder Class
// ============================================================================

/**
 * Fluent builder for item_stack_request actions
 *
 * @example
 * ```ts
 * const actionList = actions()
 *   .takeToCursor(count, source)
 *   .placeFromCursor(count, cursorStackId, dest)
 *   .build();
 * ```
 */
export class ActionBuilder {
  private actionList: ItemStackAction[] = [];

  /**
   * Take items from source to destination
   */
  take(count: number, source: SlotLocation, destination: SlotLocation): this {
    this.actionList.push({
      type_id: 'take',
      count,
      source: toSlotInfo(source),
      destination: toSlotInfo(destination),
    } as any);
    return this;
  }

  /**
   * Take items from source to cursor
   */
  takeToCursor(count: number, source: SlotLocation, cursorStackId: number = 0): this {
    return this.take(count, source, cursor(cursorStackId));
  }

  /**
   * Place items from source to destination
   */
  place(count: number, source: SlotLocation, destination: SlotLocation): this {
    this.actionList.push({
      type_id: 'place',
      count,
      source: toSlotInfo(source),
      destination: toSlotInfo(destination),
    } as any);
    return this;
  }

  /**
   * Place items from cursor to destination
   */
  placeFromCursor(count: number, cursorStackId: number, destination: SlotLocation): this {
    return this.place(count, cursor(cursorStackId), destination);
  }

  /**
   * Swap items between source and destination
   */
  swap(source: SlotLocation, destination: SlotLocation): this {
    this.actionList.push({
      type_id: 'swap',
      source: toSlotInfo(source),
      destination: toSlotInfo(destination),
    } as any);
    return this;
  }

  /**
   * Drop items from source
   */
  drop(count: number, source: SlotLocation, randomly: boolean = false): this {
    this.actionList.push({
      type_id: 'drop',
      count,
      source: toSlotInfo(source),
      randomly,
    } as any);
    return this;
  }

  /**
   * Consume items from source (used in crafting)
   */
  consume(count: number, source: SlotLocation): this {
    this.actionList.push({
      type_id: 'consume',
      count,
      source: toSlotInfo(source),
    } as any);
    return this;
  }

  /**
   * Destroy items from source (creative mode)
   */
  destroy(count: number, source: SlotLocation): this {
    this.actionList.push({
      type_id: 'destroy',
      count,
      source: toSlotInfo(source),
    } as any);
    return this;
  }

  /**
   * Create item (creative mode)
   */
  create(resultSlotId: number = 0): this {
    this.actionList.push({
      type_id: 'create',
      result_slot_id: resultSlotId,
    } as any);
    return this;
  }

  /**
   * Craft creative action (pick item from creative inventory)
   * Used with results_deprecated and take actions
   * @param itemId - The entry_id from creative_content packet
   * @param timesCrafted - How many times to craft (default 1)
   */
  craftCreative(itemId: number, timesCrafted: number = 1): this {
    this.actionList.push({
      type_id: 'craft_creative',
      item_id: itemId,
      times_crafted: timesCrafted,
    } as any);
    return this;
  }

  /**
   * Craft recipe action
   */
  craftRecipe(recipeNetworkId: number, timesCrafted: number = 1): this {
    this.actionList.push({
      type_id: 'craft_recipe',
      recipe_network_id: recipeNetworkId,
      times_crafted: timesCrafted,
    } as any);
    return this;
  }

  /**
   * Craft recipe auto action (shift-click crafting / auto ingredient sourcing)
   */
  craftRecipeAuto(recipeNetworkId: number, timesCrafted: number = 1, ingredients?: RecipeIngredient[]): this {
    this.actionList.push({
      type_id: 'craft_recipe_auto',
      recipe_network_id: recipeNetworkId,
      times_crafted: timesCrafted,
      times_crafted_2: timesCrafted,
      ingredients,
    } as any);
    return this;
  }

  /**
   * Results deprecated action (required for crafting to declare expected outputs)
   */
  resultsDeprecated(resultItems: ItemLegacy[], timesCrafted: number = 1): this {
    this.actionList.push({
      type_id: 'results_deprecated',
      result_items: resultItems,
      times_crafted: timesCrafted,
    } as any);
    return this;
  }

  /**
   * Optional action (anvil renaming, cartography)
   */
  optional(filteredStringIndex: number = 0): this {
    this.actionList.push({
      type_id: 'optional',
      filtered_string_index: filteredStringIndex,
    } as any);
    return this;
  }

  /**
   * Craft loom request action (banner patterns)
   * Note: Loom does NOT use recipeNetworkId
   */
  craftLoomRequest(timesCrafted: number = 1): this {
    this.actionList.push({
      type_id: 'craft_loom_request',
      times_crafted: timesCrafted,
    } as any);
    return this;
  }

  /**
   * Craft grindstone request action (disenchanting)
   */
  craftGrindstoneRequest(recipeNetworkId: number, timesCrafted: number = 1): this {
    this.actionList.push({
      type_id: 'craft_grindstone_request',
      recipe_network_id: recipeNetworkId,
      times_crafted: timesCrafted,
    } as any);
    return this;
  }

  /**
   * Mine block action (tool durability)
   */
  mineBlock(hotbarSlot: number, predictedDurability: number, networkId: number): this {
    this.actionList.push({
      type_id: 'mine_block',
      hotbar_slot: hotbarSlot,
      predicted_durability: predictedDurability,
      network_id: networkId,
    } as any);
    return this;
  }

  /**
   * Get the built actions array
   */
  build(): ItemStackAction[] {
    return this.actionList;
  }

  /**
   * Reset the builder for reuse
   */
  reset(): this {
    this.actionList = [];
    return this;
  }

  /**
   * Get current action count
   */
  get length(): number {
    return this.actionList.length;
  }
}

/**
 * Create a new action builder
 */
export function actions(): ActionBuilder {
  return new ActionBuilder();
}

// ============================================================================
// Request ID Management
// ============================================================================

let nextRequestId = -861;
let nextLegacyRequestId = -1;

/**
 * Get next item_stack_request ID (shared across all plugins)
 * Uses negative IDs decremented by 2
 */
export function getNextItemStackRequestId(): number {
  nextRequestId -= 2;
  return nextRequestId + 2;
}

/**
 * Get next legacy_request_id for inventory_transaction packets
 */
export function getNextLegacyRequestId(): number {
  return nextLegacyRequestId--;
}

/**
 * Reset request IDs (useful for testing)
 */
export function resetRequestIds(): void {
  nextRequestId = -861;
  nextLegacyRequestId = -1;
}

// ============================================================================
// Request Execution
// ============================================================================

export interface ItemStackResult {
  success: boolean;
  requestId: number;
}

/**
 * Send an item_stack_request and await response
 */
export async function executeRequest(bot: BedrockBot, actionList: ItemStackAction[], customNames: string[] = [], cause: number = -1, timeout: number = 5000): Promise<ItemStackResult> {
  const requestId = getNextItemStackRequestId();

  bot._client.write('item_stack_request', {
    requests: [
      {
        request_id: requestId,
        actions: actionList,
        custom_names: customNames,
        cause,
      },
    ],
  });

  const success = await waitForResponse(bot, requestId, timeout);
  return { success, requestId };
}

/**
 * Send an item_stack_request with a specific request ID
 */
export function sendRequest(bot: BedrockBot, requestId: number, actionList: ItemStackAction[], customNames: string[] = [], cause: number = -1): void {
  bot._client.write('item_stack_request', {
    requests: [
      {
        request_id: requestId,
        actions: actionList,
        custom_names: customNames,
        cause,
      },
    ],
  });
}

/**
 * Wait for item_stack_response with given request ID
 */
export function waitForResponse(bot: BedrockBot, requestId: number, timeout: number = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      bot.removeListener(`itemStackResponse:${requestId}`, handler);
      resolve(false);
    }, timeout);

    const handler = async (success: boolean) => {
      clearTimeout(timer);
      // Small delay to allow inventory updates to process
      await new Promise((r) => setTimeout(r, 100));
      resolve(success);
    };

    bot.once(`itemStackResponse:${requestId}`, handler);
  });
}

/**
 * Capture cursor stack ID from item_stack_response
 * Used for chained requests where cursor stack ID changes
 */
export function captureCursorStackId(bot: BedrockBot, requestId: number, callback: (stackId: number) => void): () => void {
  const handler = (packet: protocolTypes.packet_item_stack_response) => {
    for (const response of packet.responses) {
      if (response.request_id === requestId && response.status === 'ok') {
        for (const container of response.containers || []) {
          if (container.slot_type?.container_id === 'cursor' && container.slots?.length > 0) {
            callback(container.slots[0].item_stack_id);
          }
        }
      }
    }
  };

  bot._client.on('item_stack_response', handler);

  // Return cleanup function
  return () => {
    bot._client.removeListener('item_stack_response', handler);
  };
}

// ============================================================================
// Convenience Functions for Common Patterns
// ============================================================================

/**
 * Build a complete take-to-cursor request
 */
export function buildTakeRequest(source: SlotLocation, count: number, cursorStackId: number = 0): { actions: ItemStackAction[]; customNames: string[]; cause: number } {
  return {
    actions: actions().takeToCursor(count, source, cursorStackId).build(),
    customNames: [],
    cause: -1,
  };
}

/**
 * Build a complete place-from-cursor request
 */
export function buildPlaceRequest(destination: SlotLocation, count: number, cursorStackId: number): { actions: ItemStackAction[]; customNames: string[]; cause: number } {
  return {
    actions: actions().placeFromCursor(count, cursorStackId, destination).build(),
    customNames: [],
    cause: -1,
  };
}

/**
 * Build a swap request
 */
export function buildSwapRequest(source: SlotLocation, destination: SlotLocation): { actions: ItemStackAction[]; customNames: string[]; cause: number } {
  return {
    actions: actions().swap(source, destination).build(),
    customNames: [],
    cause: -1,
  };
}

/**
 * Build a drop request
 */
export function buildDropRequest(source: SlotLocation, count: number, randomly: boolean = false): { actions: ItemStackAction[]; customNames: string[]; cause: number } {
  return {
    actions: actions().drop(count, source, randomly).build(),
    customNames: [],
    cause: -1,
  };
}
