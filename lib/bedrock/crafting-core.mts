/**
 * Crafting Core - Recipe management and crafting utilities for Bedrock protocol
 *
 * Provides:
 * - Recipe parsing from crafting_data packet
 * - Recipe lookup by output item
 * - Ingredient matching (supports item_tag, complex_alias)
 * - Crafting execution with craft_recipe_auto
 *
 * Used by bedrockPlugins/craft.mts
 */

import type { Item } from 'prismarine-item';
import type { Block } from 'prismarine-block';
import type { BedrockBot } from '../../index.js';
import type { protocolTypes } from '../../bedrock-types.js';
import { actions, getNextItemStackRequestId, getStackId, sendRequest, waitForResponse, ContainerIds } from './item-stack-actions.mts';

// ============================================================================
// Types
// ============================================================================

type RecipeIngredient = protocolTypes.RecipeIngredient;
type ItemLegacy = protocolTypes.ItemLegacy;

/**
 * Parsed recipe structure from Bedrock crafting_data packet
 */
export interface BedrockRecipe {
  type: 'shaped' | 'shapeless' | 'furnace' | 'furnace_with_metadata' | 'smithing_transform' | 'smithing_trim' | 'multi' | 'shulker_box' | 'shapeless_chemistry' | 'shaped_chemistry';
  recipeId: string;
  networkId: number;
  uuid?: string;
  block: string;
  priority?: number;
  // For shaped recipes
  width?: number;
  height?: number;
  input: RecipeIngredient[] | RecipeIngredient[][];
  output: ItemLegacy[];
  // For smithing recipes
  template?: RecipeIngredient;
  base?: RecipeIngredient;
  addition?: RecipeIngredient;
  result?: ItemLegacy;
}

/**
 * Prismarine-recipe compatible format
 */
export interface Recipe {
  result: { id: number; count: number; metadata: number };
  inShape: { id: number; metadata: number | null }[][] | null;
  ingredients: { id: number; metadata: number | null }[] | null;
  requiresTable: boolean;
  delta: { id: number; metadata: number | null; count: number }[];
  // Bedrock-specific
  networkId: number;
  bedrockRecipe: BedrockRecipe;
}

// ============================================================================
// Slot Constants
// ============================================================================

export const CraftingSlots = {
  // 2x2 player inventory crafting grid
  CRAFTING_2X2_BASE: 28, // crafting_input:28-31 for 2x2

  // 3x3 crafting table grid
  CRAFTING_3X3_BASE: 32, // crafting_input:32-40 for 3x3

  // Creative output slot
  CREATIVE_OUTPUT_SLOT: 50,
} as const;

// ============================================================================
// Recipe Parsing
// ============================================================================

/**
 * Parse a recipe from the crafting_data packet
 */
export function parseRecipe(entry: protocolTypes.Recipes[number]): BedrockRecipe | null {
  const type = entry.type;
  const recipe = entry.recipe;

  if (!recipe) return null;

  switch (type) {
    case 'shaped':
      return {
        type,
        recipeId: recipe.recipe_id,
        networkId: recipe.network_id,
        uuid: recipe.uuid,
        block: recipe.block,
        priority: recipe.priority,
        width: recipe.width,
        height: recipe.height,
        input: recipe.input,
        output: recipe.output,
      };

    case 'shapeless':
    case 'shulker_box':
    case 'shapeless_chemistry':
      return {
        type,
        recipeId: recipe.recipe_id,
        networkId: recipe.network_id,
        uuid: recipe.uuid,
        block: recipe.block,
        priority: recipe.priority,
        input: recipe.input,
        output: recipe.output,
      };

    case 'shaped_chemistry':
      return {
        type,
        recipeId: recipe.recipe_id,
        networkId: recipe.network_id,
        uuid: recipe.uuid,
        block: recipe.block,
        priority: recipe.priority,
        width: recipe.width,
        height: recipe.height,
        input: recipe.input,
        output: recipe.output,
      };

    case 'furnace':
    case 'furnace_with_metadata':
      // Furnace recipes have different structure
      return {
        type,
        recipeId: `furnace_${recipe.input_id}_${recipe.input_meta || 0}`,
        networkId: 0, // Furnace recipes don't have network_id
        block: recipe.block,
        input: [
          {
            type: 'int_id_meta',
            network_id: recipe.input_id,
            metadata: type === 'furnace_with_metadata' ? recipe.input_meta : 32767,
            count: 1,
          },
        ],
        output: [recipe.output],
      };

    case 'smithing_transform':
      return {
        type,
        recipeId: recipe.recipe_id,
        networkId: recipe.network_id,
        block: recipe.tag || 'smithing_table',
        template: recipe.template,
        base: recipe.base,
        addition: recipe.addition,
        result: recipe.result,
        input: [],
        output: recipe.result ? [recipe.result] : [],
      };

    case 'smithing_trim':
      return {
        type,
        recipeId: recipe.recipe_id,
        networkId: recipe.network_id,
        block: recipe.block,
        template: recipe.template,
        input: [],
        output: [],
      };

    case 'multi':
      // Multi recipes are special (e.g., banner patterns, firework stars)
      return {
        type,
        recipeId: `multi_${recipe.uuid}`,
        networkId: recipe.network_id,
        uuid: recipe.uuid,
        block: 'crafting_table',
        input: [],
        output: [],
      };

    default:
      return null;
  }
}

// ============================================================================
// Recipe Utilities
// ============================================================================

/**
 * Check if a recipe can be crafted in 2x2 grid (player inventory)
 */
export function fitsIn2x2(recipe: BedrockRecipe): boolean {
  if (recipe.type === 'shaped' || recipe.type === 'shaped_chemistry') {
    const w = recipe.width || 0;
    const h = recipe.height || 0;
    return w <= 2 && h <= 2;
  }
  if (recipe.type === 'shapeless' || recipe.type === 'shulker_box' || recipe.type === 'shapeless_chemistry') {
    const ingredientCount = Array.isArray(recipe.input) ? (recipe.input as RecipeIngredient[]).length : 0;
    return ingredientCount <= 4;
  }
  return false;
}

/**
 * Get flattened ingredients from a recipe
 */
export function getIngredients(recipe: BedrockRecipe): RecipeIngredient[] {
  if (recipe.type === 'shaped' || recipe.type === 'shaped_chemistry') {
    // Flatten 2D array
    const input = recipe.input as RecipeIngredient[][];
    return input.flat();
  }
  return recipe.input as RecipeIngredient[];
}

/**
 * Resolve an ingredient to a network_id
 * Handles different ingredient types: int_id_meta, complex_alias, item_tag
 */
export function resolveIngredientId(ing: RecipeIngredient, registry: any): number {
  if (ing.type === 'invalid') return -1;

  // Direct network_id
  if (ing.network_id !== undefined && ing.network_id > 0) {
    return ing.network_id;
  }

  // complex_alias: look up by name
  if (ing.type === 'complex_alias' && (ing as any).name) {
    const name = (ing as any).name as string;
    // Remove "minecraft:" prefix and look up in registry
    const shortName = name.replace('minecraft:', '');
    const item = registry.itemsByName[shortName];
    if (item) return item.id;
  }

  // item_tag: best-effort resolution based on tag name
  // Common tags: minecraft:coals → coal
  if (ing.type === 'item_tag' && (ing as any).tag) {
    const tag = (ing as any).tag as string;
    // Try to extract item name from tag (e.g., "minecraft:coals" → "coal")
    const tagName = tag.replace('minecraft:', '').replace(/s$/, ''); // Remove trailing 's'
    const item = registry.itemsByName[tagName];
    if (item) return item.id;
  }

  return 0;
}

/**
 * Check if an inventory item matches an ingredient
 * Handles different ingredient types including item_tag
 */
export function itemMatchesIngredient(item: Item, ing: RecipeIngredient): boolean {
  if (ing.type === 'invalid') return false;

  // Direct network_id match
  if (ing.network_id !== undefined && ing.network_id > 0) {
    if (item.type !== ing.network_id) return false;
    // Check metadata if specified (32767 = wildcard)
    if (ing.metadata !== undefined && ing.metadata !== 32767 && item.metadata !== ing.metadata) {
      return false;
    }
    return true;
  }

  // complex_alias: match by name
  if (ing.type === 'complex_alias' && (ing as any).name) {
    const name = (ing as any).name as string;
    const shortName = name.replace('minecraft:', '');
    return item.name === shortName;
  }

  // item_tag: check if item has the tag
  // For now, use simple name matching (e.g., "minecraft:coals" matches "coal", "charcoal")
  if (ing.type === 'item_tag' && (ing as any).tag) {
    const tag = (ing as any).tag as string;
    const tagName = tag.replace('minecraft:', '');
    // Check common tag patterns
    if (tagName === 'coals') {
      return item.name === 'coal' || item.name === 'charcoal';
    }
    if (tagName === 'logs' || tagName === 'oak_logs') {
      return item.name?.endsWith('_log') || item.name?.endsWith('_wood');
    }
    if (tagName === 'planks') {
      return item.name?.endsWith('_planks');
    }
    // Generic: try singular form
    const singular = tagName.replace(/s$/, '');
    return item.name === singular || item.name === tagName;
  }

  return false;
}

/**
 * Count items in inventory that match an ingredient
 */
export function countMatchingItems(bot: BedrockBot, ing: RecipeIngredient): number {
  let count = 0;
  for (const item of bot.inventory.slots) {
    if (!item) continue;
    if (itemMatchesIngredient(item, ing)) {
      count += item.count;
    }
  }
  return count;
}

/**
 * Find inventory slots containing items that match a recipe ingredient
 */
export function findIngredientSlots(bot: BedrockBot, ingredient: RecipeIngredient): number[] {
  const slots: number[] = [];

  for (let i = 0; i < bot.inventory.slots.length; i++) {
    const item = bot.inventory.slots[i];
    if (!item) continue;

    if (itemMatchesIngredient(item, ingredient)) {
      slots.push(i);
    }
  }
  return slots;
}

// ============================================================================
// Recipe Conversion
// ============================================================================

/**
 * Convert Bedrock recipe to prismarine-recipe compatible format
 */
export function convertToRecipe(bedrock: BedrockRecipe, registry: any): Recipe {
  const output = bedrock.output[0] || { network_id: 0, count: 1, metadata: 0 };

  // Determine if recipe requires crafting table
  const requiresTable = !fitsIn2x2(bedrock) || (bedrock.block !== 'deprecated' && !fitsIn2x2(bedrock));

  // Build inShape for shaped recipes
  let inShape: { id: number; metadata: number | null }[][] | null = null;
  let ingredients: { id: number; metadata: number | null }[] | null = null;

  if (bedrock.type === 'shaped' || bedrock.type === 'shaped_chemistry') {
    const input = bedrock.input as RecipeIngredient[][];
    inShape = input.map((row) =>
      row.map((ing) => ({
        id: ing.type === 'invalid' ? -1 : ing.network_id || 0,
        metadata: ing.metadata === 32767 ? null : ing.metadata || null,
      }))
    );
  } else if (bedrock.type === 'shapeless' || bedrock.type === 'shulker_box' || bedrock.type === 'shapeless_chemistry') {
    const input = bedrock.input as RecipeIngredient[];
    ingredients = input.map((ing) => ({
      id: ing.network_id || 0,
      metadata: ing.metadata === 32767 ? null : ing.metadata || null,
    }));
  }

  // Compute delta (inventory change)
  const delta: { id: number; metadata: number | null; count: number }[] = [];

  // Add consumed ingredients (negative)
  for (const ing of getIngredients(bedrock)) {
    if (ing.type === 'invalid') continue;
    const id = resolveIngredientId(ing, registry);
    const metadata = ing.metadata === 32767 ? null : ing.metadata || null;
    const existing = delta.find((d) => d.id === id && d.metadata === metadata);
    if (existing) {
      existing.count -= ing.count;
    } else {
      delta.push({ id, metadata, count: -ing.count });
    }
  }

  // Add produced output (positive)
  for (const out of bedrock.output) {
    const id = out.network_id;
    const metadata = out.metadata || null;
    const existing = delta.find((d) => d.id === id && d.metadata === metadata);
    if (existing) {
      existing.count += out.count;
    } else {
      delta.push({ id, metadata, count: out.count });
    }
  }

  return {
    result: {
      id: output.network_id,
      count: output.count,
      metadata: output.metadata || 0,
    },
    inShape,
    ingredients,
    requiresTable,
    delta,
    networkId: bedrock.networkId,
    bedrockRecipe: bedrock,
  };
}

// ============================================================================
// Recipe Lookup
// ============================================================================

/**
 * Find all recipes that produce a given item
 */
export function findRecipesByOutput(recipesByOutputId: Map<number, BedrockRecipe[]>, registry: any, itemType: number, metadata: number | null): Recipe[] {
  const bedrock = recipesByOutputId.get(itemType) || [];
  return bedrock
    .filter((r) => {
      // Filter by metadata if specified
      if (metadata !== null) {
        const output = r.output[0];
        if (output && output.metadata !== metadata && output.metadata !== 32767) {
          return false;
        }
      }
      return true;
    })
    .map((r) => convertToRecipe(r, registry));
}

/**
 * Check if player has enough items for a recipe
 */
export function hasIngredientsFor(bot: BedrockBot, recipe: Recipe, count: number = 1): boolean {
  const bedrock = recipe.bedrockRecipe;
  const ingredients = getIngredients(bedrock);

  // Track how many of each ingredient slot we need
  const needed = new Map<string, { ing: RecipeIngredient; count: number }>();

  for (const ing of ingredients) {
    if (ing.type === 'invalid') continue;

    // Create a key for this ingredient type
    const key = JSON.stringify({ type: ing.type, network_id: ing.network_id, tag: (ing as any).tag, name: (ing as any).name });
    const existing = needed.get(key);
    if (existing) {
      existing.count += ing.count * count;
    } else {
      needed.set(key, { ing, count: ing.count * count });
    }
  }

  // Check if we have enough of each ingredient
  for (const [, { ing, count: neededCount }] of needed) {
    const available = countMatchingItems(bot, ing);
    if (available < neededCount) {
      return false;
    }
  }

  return true;
}

// ============================================================================
// Crafting Execution
// ============================================================================

/**
 * Craft using craft_recipe_auto action
 * This tells the server to automatically source ingredients.
 *
 * Based on real client packet captures, the format is:
 * 1. craft_recipe_auto with recipe_network_id, times_crafted, times_crafted_2, ingredients
 * 2. results_deprecated with result_items and times_crafted
 * 3. consume actions from hotbar_and_inventory for each ingredient slot
 * 4. place action from creative_output:50 to hotbar_and_inventory
 */
export async function craftWithAuto(
  bot: BedrockBot,
  bedrock: BedrockRecipe,
  Item: any // Item constructor from prismarine-item
): Promise<void> {
  const requestId = getNextItemStackRequestId();
  const outputCount = bedrock.output[0]?.count ?? 1;
  const ingredients = getIngredients(bedrock).filter((ing) => ing.type !== 'invalid');

  // Build result_items for results_deprecated
  const resultItems = bedrock.output.map((output) => ({
    network_id: output.network_id,
    count: output.count,
    metadata: output.metadata ?? 0,
    block_runtime_id: output.block_runtime_id ?? 0,
    extra: output.extra ?? { has_nbt: 0, can_place_on: [], can_destroy: [] },
  }));

  // Find inventory slots with ingredients and build consume actions
  const consumeActions: any[] = [];
  const ingredientCounts = new Map<number, { slot: number; stackId: number; count: number }>();
  const resolvedIngredients: RecipeIngredient[] = [];

  for (const ing of ingredients) {
    if (ing.type === 'invalid') continue;

    // Find a slot with this ingredient using itemMatchesIngredient
    for (let slot = 0; slot < bot.inventory.slots.length; slot++) {
      const item = bot.inventory.slots[slot];
      if (!item) continue;
      if (!itemMatchesIngredient(item, ing)) continue;

      const key = slot;
      const existing = ingredientCounts.get(key);
      if (existing) {
        existing.count += ing.count;
      } else {
        ingredientCounts.set(key, {
          slot,
          stackId: getStackId(item),
          count: ing.count,
        });
      }

      // Resolve item_tag/complex_alias to int_id_meta using the actual item
      if (ing.type === 'item_tag' || ing.type === 'complex_alias') {
        resolvedIngredients.push({
          type: 'int_id_meta',
          network_id: item.type,
          metadata: item.metadata ?? 32767,
          count: ing.count,
        } as RecipeIngredient);
      } else {
        resolvedIngredients.push(ing);
      }

      break;
    }
  }

  // Build consume actions
  let firstConsume = true;
  for (const [, info] of ingredientCounts) {
    consumeActions.push({
      type_id: 'consume',
      count: info.count,
      source: {
        slot_type: { container_id: ContainerIds.HOTBAR_AND_INVENTORY },
        slot: info.slot,
        stack_id: firstConsume ? info.stackId : requestId,
      },
    });
    firstConsume = false;
  }

  // Find an empty slot for the output
  let outputSlot = -1;
  for (let slot = 0; slot < bot.inventory.slots.length; slot++) {
    if (!bot.inventory.slots[slot]) {
      outputSlot = slot;
      break;
    }
  }
  if (outputSlot === -1) {
    throw new Error('No empty inventory slot for crafting output');
  }

  const actionList: any[] = [
    {
      type_id: 'craft_recipe_auto',
      recipe_network_id: bedrock.networkId,
      times_crafted_2: 1,
      times_crafted: 1,
      ingredients: resolvedIngredients,
    },
    {
      type_id: 'results_deprecated',
      result_items: resultItems,
      times_crafted: 1,
    },
    ...consumeActions,
    {
      type_id: 'place',
      count: outputCount,
      source: {
        slot_type: { container_id: ContainerIds.CREATIVE_OUTPUT },
        slot: CraftingSlots.CREATIVE_OUTPUT_SLOT,
        stack_id: requestId,
      },
      destination: {
        slot_type: { container_id: ContainerIds.HOTBAR_AND_INVENTORY },
        slot: outputSlot,
        stack_id: 0,
      },
    },
  ];

  bot.logger.info(`Sending craft_recipe_auto: id=${requestId}, recipe=${bedrock.networkId}`);
  bot.logger.debug(`  original ingredients: ${JSON.stringify(ingredients)}`);
  bot.logger.debug(`  resolved ingredients: ${JSON.stringify(resolvedIngredients)}`);
  bot.logger.debug(`  actions: ${JSON.stringify(actionList)}`);

  sendRequest(bot, requestId, actionList);

  const success = await waitForResponse(bot, requestId);
  if (!success) {
    throw new Error('Crafting failed - server rejected craft_recipe_auto request');
  }

  // Create the output item in the destination slot
  const output = bedrock.output[0];
  if (output) {
    const newItem = new Item(output.network_id, outputCount, output.metadata ?? 0);
    (newItem as any).stackId = requestId;
    bot.inventory.updateSlot(outputSlot, newItem);
    bot.logger.debug(`Created crafted item in slot ${outputSlot}: ${output.network_id} x${outputCount}`);
  }
}

/**
 * Find an item in all inventory slots by type or name
 */
export function findItemInAllSlots(bot: BedrockBot, itemTypeOrName: number | string, metadata: number | null): Item | null {
  for (let i = 0; i < bot.inventory.slots.length; i++) {
    const item = bot.inventory.slots[i];
    if (!item) continue;

    const matches = typeof itemTypeOrName === 'number' ? item.type === itemTypeOrName : item.name === itemTypeOrName;

    if (matches && (metadata === null || item.metadata === metadata)) {
      return item;
    }
  }
  return null;
}

/**
 * Count items across all inventory slots
 */
export function countAllItems(bot: BedrockBot, itemType: number, metadata: number | null): number {
  let sum = 0;
  for (const item of bot.inventory.slots) {
    if (item && item.type === itemType && (metadata === null || metadata === 32767 || item.metadata === metadata)) {
      sum += item.count;
    }
  }
  return sum;
}
