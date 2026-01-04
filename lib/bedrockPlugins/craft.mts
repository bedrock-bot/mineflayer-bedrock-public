import type { Block } from 'prismarine-block';
import type { BedrockBot } from '../../index.js';
import itemLoader, { type Item } from 'prismarine-item';

// Import shared utilities from lib/bedrock/
import {
  // Types
  type BedrockRecipe,
  type Recipe,

  // Recipe utilities
  parseRecipe,
  fitsIn2x2,
  getIngredients,
  resolveIngredientId,
  itemMatchesIngredient,
  countMatchingItems,
  findIngredientSlots,
  convertToRecipe,
  findRecipesByOutput,
  hasIngredientsFor,
  craftWithAuto,
  findItemInAllSlots,
  countAllItems,
  CraftingSlots,

  // Request utilities
  getNextItemStackRequestId,
  waitForResponse,
  actions,
  sendRequest,
  slot as makeSlot,
  cursor,
  getStackId,
  getContainerForCursorOp,

  // Workstations
  openFurnace as _openFurnace,
  openAnvil as _openAnvil,
  openEnchantmentTable as _openEnchantmentTable,
  openSmithingTable as _openSmithingTable,
  openStonecutter as _openStonecutter,
  openGrindstone as _openGrindstone,
  openLoom as _openLoom,
  openBrewingStand as _openBrewingStand,
  openCartographyTable as _openCartographyTable,
} from '../bedrock/index.mts';

// Re-export types for backwards compatibility
export type { BedrockRecipe, Recipe };

/**
 * Bedrock Craft Plugin
 *
 * Implements crafting API compatible with Java mineflayer:
 * - bot.craft(recipe, count, craftingTable)
 * - bot.recipesFor(itemType, metadata, minResultCount, craftingTable)
 * - bot.recipesAll(itemType, metadata, craftingTable)
 *
 * Additional Bedrock-specific APIs:
 * - bot.openStonecutter(block) - Open stonecutter and craft
 * - bot.openFurnace(block) - Open furnace for smelting
 * - bot.openEnchantmentTable(block) - Open enchanting table
 * - bot.openAnvil(block) - Open anvil for repair/rename
 * - bot.openSmithingTable(block) - Open smithing table for upgrades
 * - bot.openGrindstone(block) - Open grindstone for disenchanting
 * - bot.openLoom(block) - Open loom for banner patterns
 * - bot.openBrewingStand(block) - Open brewing stand for potions
 * - bot.openCartographyTable(block) - Open cartography table for maps
 *
 * Recipes are received via crafting_data packet at login.
 */

// Workstation slot constants (kept for local use in 2x2 crafting)
const CRAFTING_2X2_BASE_SLOT = CraftingSlots.CRAFTING_2X2_BASE;
const CRAFTING_3X3_BASE_SLOT = CraftingSlots.CRAFTING_3X3_BASE;

// Recipe types from Bedrock protocol
type RecipeIngredient = protocolTypes.RecipeIngredient;
type ItemLegacy = protocolTypes.ItemLegacy;

export default function inject(bot: BedrockBot) {
  // Create Item class from registry
  const Item = (itemLoader as any)(bot.registry) as typeof import('prismarine-item').Item;

  // Recipe storage indexed by output network_id
  const recipesByOutputId = new Map<number, BedrockRecipe[]>();
  // All recipes indexed by recipe network_id
  const recipesByNetworkId = new Map<number, BedrockRecipe>();
  // Unlocked recipes by recipe_id string
  const unlockedRecipes = new Set<string>();
  // Flag to track if recipes are loaded
  let recipesLoaded = false;

  // Handle unlocked_recipes packet
  bot._client.on('unlocked_recipes', (packet: protocolTypes.packet_unlocked_recipes) => {
    bot.logger.info(`unlocked_recipes: type=${packet.unlock_type}, count=${packet.recipes?.length ?? 0}, recipes=${packet.recipes?.join(', ')}`);
    if (packet.unlock_type === 'remove_all_unlocked') {
      unlockedRecipes.clear();
    } else if (packet.unlock_type === 'remove_unlocked') {
      for (const recipeId of packet.recipes) {
        unlockedRecipes.delete(recipeId);
      }
    } else {
      // initially_unlocked, newly_unlocked, empty
      for (const recipeId of packet.recipes) {
        unlockedRecipes.add(recipeId);
      }
    }
    bot.logger.debug(`Unlocked recipes total: ${unlockedRecipes.size}`);
  });

  // Handle crafting_data packet - wait for item_registry first (with timeout)
  bot._client.on('crafting_data', async (packet: protocolTypes.packet_crafting_data) => {
    // Wait for item_registry to be processed first so network_ids are correct
    // Use a timeout in case item_registry never arrives (older server versions)
    if ((bot as any).item_registry_task) {
      await Promise.race([(bot as any).item_registry_task.promise, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }

    if (packet.clear_recipes) {
      recipesByOutputId.clear();
      recipesByNetworkId.clear();
    }

    for (const entry of packet.recipes) {
      const recipe = parseRecipe(entry);
      if (!recipe) continue;

      // Index by network_id
      recipesByNetworkId.set(recipe.networkId, recipe);

      // Index by output network_id (for recipe lookup)
      for (const output of recipe.output) {
        const outputId = output.network_id;
        if (!recipesByOutputId.has(outputId)) {
          recipesByOutputId.set(outputId, []);
        }
        recipesByOutputId.get(outputId)!.push(recipe);
      }
    }

    recipesLoaded = true;
    bot.logger.debug(`Loaded ${recipesByNetworkId.size} recipes`);
  });

  /**
   * Parse a recipe from the crafting_data packet
   */
  function parseRecipe(entry: protocolTypes.Recipes[number]): BedrockRecipe | null {
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

  /**
   * Check if a recipe can be crafted in 2x2 grid (player inventory)
   */
  function fitsIn2x2(recipe: BedrockRecipe): boolean {
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
  function getIngredients(recipe: BedrockRecipe): RecipeIngredient[] {
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
  function resolveIngredientId(ing: RecipeIngredient): number {
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
      const item = bot.registry.itemsByName[shortName];
      if (item) return item.id;
    }

    // item_tag: best-effort resolution based on tag name
    // Common tags: minecraft:coals → coal
    if (ing.type === 'item_tag' && (ing as any).tag) {
      const tag = (ing as any).tag as string;
      // Try to extract item name from tag (e.g., "minecraft:coals" → "coal")
      const tagName = tag.replace('minecraft:', '').replace(/s$/, ''); // Remove trailing 's'
      const item = bot.registry.itemsByName[tagName];
      if (item) return item.id;
    }

    return 0;
  }

  /**
   * Check if an inventory item matches an ingredient
   * Handles different ingredient types including item_tag
   */
  function itemMatchesIngredient(item: Item, ing: RecipeIngredient): boolean {
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
   * Convert Bedrock recipe to prismarine-recipe compatible format
   */
  function convertToRecipe(bedrock: BedrockRecipe): Recipe {
    const output = bedrock.output[0] || { network_id: 0, count: 1, metadata: 0 };

    // Determine if recipe requires crafting table
    // A recipe requires table if it doesn't fit in 2x2 OR if block is not 'deprecated'
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
      // Use resolveIngredientId to handle complex_alias and item_tag types
      const id = resolveIngredientId(ing);
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

  /**
   * Find all recipes that produce a given item
   */
  function findRecipesByOutput(itemType: number, metadata: number | null): Recipe[] {
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
      .map(convertToRecipe);
  }

  /**
   * Count items across ALL inventory slots (hotbar + main inventory)
   * bot.inventory.count() only searches inventoryStart-inventoryEnd which may exclude hotbar
   */
  function countAllItems(itemType: number, metadata: number | null): number {
    let sum = 0;
    for (const item of bot.inventory.slots) {
      if (item && item.type === itemType && (metadata === null || metadata === 32767 || item.metadata === metadata)) {
        sum += item.count;
      }
    }
    return sum;
  }

  /**
   * Find an item in ALL inventory slots (hotbar + main inventory + all other slots)
   * Unlike findInventoryItem which only searches inventoryStart-inventoryEnd,
   * this searches all slots and can find by type (number) or name (string)
   */
  function findItemInAllSlots(itemTypeOrName: number | string, metadata: number | null): Item | null {
    // Search all slots, not just 0-35
    for (let i = 0; i < bot.inventory.slots.length; i++) {
      const item = bot.inventory.slots[i];
      if (!item) continue;

      // Match by type (number) or name (string)
      const matches = typeof itemTypeOrName === 'number' ? item.type === itemTypeOrName : item.name === itemTypeOrName;

      if (matches && (metadata === null || item.metadata === metadata)) {
        return item;
      }
    }
    return null;
  }

  /**
   * Count items in inventory that match an ingredient
   * Handles item_tag and complex_alias types
   */
  function countMatchingItems(ing: RecipeIngredient): number {
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
   * Check if player has enough items for a recipe
   * Directly checks ingredients to handle item_tag and complex_alias types
   */
  function hasIngredientsFor(recipe: Recipe, count: number = 1): boolean {
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
      const available = countMatchingItems(ing);
      if (available < neededCount) {
        return false;
      }
    }

    return true;
  }

  /**
   * Find recipes for a given item that the player can craft
   */
  function recipesFor(itemType: number, metadata: number | null = null, minResultCount: number = 1, craftingTable: Block | boolean | null = null): Recipe[] {
    const recipes = findRecipesByOutput(itemType, metadata);
    return recipes.filter((recipe) => {
      // Check if recipe requires table
      if (recipe.requiresTable && !craftingTable) {
        return false;
      }

      // Check if we have enough ingredients
      const craftCount = Math.ceil(minResultCount / recipe.result.count);
      return hasIngredientsFor(recipe, craftCount);
    });
  }

  /**
   * Find all recipes for a given item (regardless of whether player has ingredients)
   */
  function recipesAll(itemType: number, metadata: number | null = null, craftingTable: Block | boolean | null = null): Recipe[] {
    const recipes = findRecipesByOutput(itemType, metadata);
    return recipes.filter((recipe) => {
      if (recipe.requiresTable && !craftingTable) {
        return false;
      }
      return true;
    });
  }

  /**
   * Wait for item_stack_response with given request_id
   */
  function waitForStackResponse(requestId: number, timeout: number = 5000): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        bot._client.removeListener('item_stack_response', handler);
        resolve(false);
      }, timeout);

      const handler = (packet: protocolTypes.packet_item_stack_response) => {
        for (const response of packet.responses) {
          if (response.request_id === requestId) {
            clearTimeout(timer);
            bot._client.removeListener('item_stack_response', handler);
            bot.logger.debug(`craft response: status=${response.status}`);
            resolve(response.status === 'ok');
            return;
          }
        }
      };

      bot._client.on('item_stack_response', handler);
    });
  }

  /**
   * Pick up items from inventory slot to cursor
   * Uses hotbar/inventory containers matching the existing inventory plugin
   */
  async function takeToCursor(sourceSlot: number, count: number): Promise<boolean> {
    const sourceItem = bot.inventory.slots[sourceSlot];
    if (!sourceItem) return false;

    // Map slot to container
    if (sourceSlot < 0 || sourceSlot > 35) {
      bot.logger.warn(`Unsupported slot index for crafting: ${sourceSlot}`);
      return false;
    }

    const container = getContainerForCursorOp(sourceSlot);
    const stackId = getStackId(sourceItem);
    const requestId = getNextItemStackRequestId();

    bot.logger.info(`takeToCursor: take ${count} from ${container.containerId}:${container.slot} to cursor (item: ${sourceItem.type}, stackId: ${stackId})`);

    sendRequest(
      bot,
      requestId,
      actions()
        .takeToCursor(count, makeSlot(container.containerId, container.slot, stackId))
        .build()
    );

    return waitForStackResponse(requestId);
  }

  /**
   * Place items from cursor to crafting grid slot
   * Real client pattern: place from cursor to crafting_input
   */
  async function placeFromCursor(craftingSlot: number, count: number): Promise<boolean> {
    const requestId = getNextItemStackRequestId();

    bot.logger.debug(`placeFromCursor: place ${count} from cursor to crafting_input:${craftingSlot}`);

    sendRequest(
      bot,
      requestId,
      actions()
        .placeFromCursor(count, 0, makeSlot('crafting_input', craftingSlot, 0))
        .build()
    );

    return waitForStackResponse(requestId);
  }

  /**
   * Place an item from inventory to crafting grid using cursor-based approach
   * Step 1: Pick up item from inventory to cursor
   * Step 2: Place item from cursor to crafting_input
   * Returns the stack_id of the placed item
   */
  async function placeInCraftingGrid(sourceSlot: number, craftingSlot: number, count: number): Promise<{ success: boolean; stackId: number }> {
    const sourceItem = bot.inventory.slots[sourceSlot];
    if (!sourceItem) return { success: false, stackId: 0 };

    const sourceStackId = getStackId(sourceItem);

    // Step 1: Pick up item to cursor
    const takeRequestId = getNextItemStackRequestId();

    bot.logger.info(`placeInCraftingGrid step1: take ${count} from hotbar_and_inventory:${sourceSlot} to cursor`);

    sendRequest(
      bot,
      takeRequestId,
      actions()
        .takeToCursor(count, makeSlot('hotbar_and_inventory', sourceSlot, sourceStackId))
        .build()
    );

    // Wait for take response
    const takeSuccess = await waitForStackResponse(takeRequestId);
    if (!takeSuccess) {
      bot.logger.error('Failed to take item to cursor');
      return { success: false, stackId: 0 };
    }

    // Step 2: Place item from cursor to crafting_input
    const placeRequestId = getNextItemStackRequestId();

    // Get the current crafting window ID
    const craftingWindow = bot.currentWindow;
    const windowId = craftingWindow?.id ?? 0;

    bot.logger.info(`placeInCraftingGrid step2: place ${count} from cursor to crafting_input:${craftingSlot} (window=${windowId})`);

    sendRequest(
      bot,
      placeRequestId,
      actions()
        .placeFromCursor(count, sourceStackId, {
          containerId: 'crafting_input',
          slot: craftingSlot,
          stackId: 0,
          dynamicContainerId: windowId,
        })
        .build()
    );

    // Wait for place response
    const placeSuccess = await waitForStackResponse(placeRequestId);
    return { success: placeSuccess, stackId: sourceStackId };
  }

  /**
   * Check if a recipe is unlocked for the player
   */
  function isRecipeUnlocked(recipeId: string): boolean {
    return unlockedRecipes.has(recipeId);
  }

  /**
   * Find inventory slots containing items that match a recipe ingredient
   */
  function findIngredientSlots(ingredient: RecipeIngredient): number[] {
    const slots: number[] = [];

    for (let i = 0; i < bot.inventory.slots.length; i++) {
      const item = bot.inventory.slots[i];
      if (!item) continue;

      // Use itemMatchesIngredient to handle complex_alias and item_tag types
      if (itemMatchesIngredient(item, ingredient)) {
        slots.push(i);
      }
    }
    return slots;
  }

  /**
   * Craft a recipe once using item_stack_request
   * Uses craft_recipe_auto for crafting table, craft_recipe with manual placement for 2x2 inventory.
   */
  async function craftOnce(recipe: Recipe, craftingTable: Block | null): Promise<void> {
    const bedrock = recipe.bedrockRecipe;

    // Check if recipe is unlocked
    if (!isRecipeUnlocked(bedrock.recipeId)) {
      bot.logger.warn(`Recipe ${bedrock.recipeId} is not unlocked! Attempting anyway...`);
      bot.logger.debug(`Unlocked recipes (${unlockedRecipes.size}): ${Array.from(unlockedRecipes).slice(0, 10).join(', ')}...`);
    }

    // For shaped/shapeless recipes
    if (bedrock.type === 'shaped' || bedrock.type === 'shapeless' || bedrock.type === 'shulker_box' || bedrock.type === 'shapeless_chemistry' || bedrock.type === 'shaped_chemistry') {
      // Check if recipe physically requires crafting table (doesn't fit in 2x2)
      const needsTable = recipe.requiresTable;

      if (craftingTable) {
        // Crafting with table - use craft_recipe_auto (shift-click style)
        const craftingWindow = await bot.openBlock(craftingTable);
        bot.logger.debug(`Opened crafting table window: ${craftingWindow?.id}`);
        await new Promise((resolve) => setTimeout(resolve, 100));

        try {
          await craftWithAuto(bedrock);
        } finally {
          bot.closeWindow(craftingWindow);
        }
      } else if (needsTable) {
        throw new Error(`Recipe ${bedrock.recipeId} requires crafting table (doesn't fit in 2x2 grid)`);
      } else {
        // 2x2 crafting WITHOUT table
        // NOTE: Bedrock protocol limitation - 2x2 crafting requires the inventory screen to be open,
        // which bots cannot do. Users should provide a crafting table for reliable crafting.
        // We'll still try craft_recipe_auto but it may be rejected by the server.
        bot.logger.debug(`Attempting ${bedrock.recipeId} in 2x2 player inventory - may require crafting table`);
        try {
          await craftWithAuto(bedrock);
        } catch (err) {
          throw new Error(
            `2x2 crafting without table not supported - Bedrock requires inventory screen to be open. ` + `Please provide a crafting table for recipe ${bedrock.recipeId}. Original error: ${err}`
          );
        }
      }
    } else {
      throw new Error(`Recipe type ${bedrock.type} not yet supported for crafting`);
    }
  }

  /**
   * Craft using 2x2 player inventory grid with manual placement
   * Based on packet captures:
   * 1. Place items from inventory to crafting_input:28-31
   * 2. Send craft_recipe action with consume + take
   */
  async function craftWith2x2Manual(bedrock: BedrockRecipe): Promise<void> {
    const placedSlots: { craftSlot: number; count: number; stackId: number }[] = [];

    // Place ingredients in 2x2 grid (crafting_input:28-31)
    if (bedrock.type === 'shaped' || bedrock.type === 'shaped_chemistry') {
      const input = bedrock.input as RecipeIngredient[][];
      const width = bedrock.width || 1;
      const height = bedrock.height || 1;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const ing = input[y]?.[x];
          if (!ing || ing.type === 'invalid') continue;

          // Map to 2x2 grid: slot 28 = top-left, 29 = top-right, 30 = bottom-left, 31 = bottom-right
          const craftSlot = CRAFTING_2X2_BASE_SLOT + y * 2 + x;
          const srcSlots = findIngredientSlots(ing);
          if (srcSlots.length === 0) {
            throw new Error(`Missing ingredient: type=${ing.type}, id=${ing.network_id}`);
          }

          const placeResult = await placeInCraftingGrid2x2(srcSlots[0], craftSlot, ing.count);
          if (!placeResult.success) {
            throw new Error(`Failed to place ingredient in crafting slot ${craftSlot}`);
          }
          placedSlots.push({ craftSlot, count: ing.count, stackId: placeResult.stackId });
        }
      }
    } else {
      // Shapeless - place in order
      const input = bedrock.input as RecipeIngredient[];
      let slotIndex = 0;
      for (const ing of input) {
        if (ing.type === 'invalid') continue;

        const craftSlot = CRAFTING_2X2_BASE_SLOT + slotIndex++;
        const srcSlots = findIngredientSlots(ing);
        if (srcSlots.length === 0) {
          throw new Error(`Missing ingredient: type=${ing.type}, id=${ing.network_id}`);
        }

        const placeResult = await placeInCraftingGrid2x2(srcSlots[0], craftSlot, ing.count);
        if (!placeResult.success) {
          throw new Error(`Failed to place ingredient in crafting slot ${craftSlot}`);
        }
        placedSlots.push({ craftSlot, count: ing.count, stackId: placeResult.stackId });
      }
    }

    // Send craft_recipe with consume + take actions
    const requestId = getNextItemStackRequestId();
    const outputCount = bedrock.output[0]?.count ?? 1;

    const resultItems = bedrock.output.map((output) => ({
      network_id: output.network_id,
      count: output.count,
      metadata: output.metadata ?? 0,
      block_runtime_id: output.block_runtime_id ?? 0,
      extra: output.extra ?? { has_nbt: 0, can_place_on: [], can_destroy: [] },
    }));

    // Build crafting actions using ActionBuilder
    const builder = actions().craftRecipe(bedrock.networkId, 1).resultsDeprecated(resultItems, 1);

    // Add consume actions for each placed ingredient
    for (const placed of placedSlots) {
      builder.consume(placed.count, makeSlot('crafting_input', placed.craftSlot, placed.stackId));
    }

    // Take result to cursor
    builder.takeToCursor(outputCount, makeSlot('creative_output', 50, requestId));

    bot.logger.info(`Sending craft_recipe (2x2): id=${requestId}, recipe=${bedrock.networkId}`);

    sendRequest(bot, requestId, builder.build());

    const success = await waitForStackResponse(requestId);
    if (!success) {
      throw new Error('Crafting failed - server rejected craft_recipe request');
    }

    // Move result from cursor to inventory
    await bot.putAway(0);
  }

  /**
   * Place item from inventory to 2x2 crafting grid
   * Uses two-step approach: take to cursor, then place in crafting_input
   * From packet captures: Real client uses 'inventory' container for slots 9+, 'hotbar' for 0-8
   */
  async function placeInCraftingGrid2x2(sourceSlot: number, craftingSlot: number, count: number): Promise<{ success: boolean; stackId: number }> {
    const sourceItem = bot.inventory.slots[sourceSlot];
    if (!sourceItem) return { success: false, stackId: 0 };

    const sourceStackId = getStackId(sourceItem);
    const container = getContainerForCursorOp(sourceSlot);

    // Step 1: Take from inventory/hotbar to cursor
    const takeRequestId = getNextItemStackRequestId();
    bot.logger.debug(`2x2 step1: take ${count} from ${container.containerId}:${sourceSlot} to cursor`);

    sendRequest(
      bot,
      takeRequestId,
      actions()
        .takeToCursor(count, makeSlot(container.containerId, container.slot, sourceStackId))
        .build()
    );

    const takeSuccess = await waitForStackResponse(takeRequestId);
    if (!takeSuccess) {
      bot.logger.error('Failed to take item to cursor for 2x2 crafting');
      return { success: false, stackId: 0 };
    }

    // Step 2: Place from cursor to crafting_input
    const placeRequestId = getNextItemStackRequestId();
    bot.logger.debug(`2x2 step2: place ${count} from cursor to crafting_input:${craftingSlot}`);

    sendRequest(
      bot,
      placeRequestId,
      actions()
        .placeFromCursor(count, sourceStackId, makeSlot('crafting_input', craftingSlot, 0))
        .build()
    );

    const placeSuccess = await waitForStackResponse(placeRequestId);
    return { success: placeSuccess, stackId: sourceStackId };
  }

  /**
   * Craft using craft_recipe_auto action
   * This tells the server to automatically source ingredients.
   * Based on real client packet captures, the format is:
   * 1. craft_recipe_auto with recipe_network_id, times_crafted, times_crafted_2, ingredients
   * 2. results_deprecated with result_items and times_crafted
   * 3. consume actions from hotbar_and_inventory for each ingredient slot
   * 4. place action from creative_output:50 to hotbar_and_inventory
   */
  async function craftWithAuto(bedrock: BedrockRecipe): Promise<void> {
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

    // Find inventory slots with ingredients
    // Also resolve item_tag/complex_alias to actual int_id_meta for the ingredients array
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
            stackId: (item as any).stackId ?? 0,
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

    // Build crafting actions using ActionBuilder
    const builder = actions().craftRecipeAuto(bedrock.networkId, 1, resolvedIngredients).resultsDeprecated(resultItems, 1);

    // Add consume actions for each ingredient
    let firstConsume = true;
    for (const [, info] of ingredientCounts) {
      const stackId = firstConsume ? info.stackId : requestId;
      builder.consume(info.count, makeSlot('hotbar_and_inventory', info.slot, stackId));
      firstConsume = false;
    }

    // Place result directly to inventory
    builder.place(outputCount, makeSlot('creative_output', 50, requestId), makeSlot('hotbar_and_inventory', outputSlot, 0));

    bot.logger.info(`Sending craft_recipe_auto: id=${requestId}, recipe=${bedrock.networkId}`);
    bot.logger.debug(`  original ingredients: ${JSON.stringify(ingredients)}`);
    bot.logger.debug(`  resolved ingredients: ${JSON.stringify(resolvedIngredients)}`);

    sendRequest(bot, requestId, builder.build());

    const success = await waitForStackResponse(requestId);
    if (!success) {
      throw new Error('Crafting failed - server rejected craft_recipe_auto request');
    }

    // Create the output item in the destination slot
    // item_stack_response only updates counts, not create new items
    const output = bedrock.output[0];
    if (output) {
      const newItem = new Item(output.network_id, outputCount, output.metadata ?? 0);
      (newItem as any).stackId = requestId; // Use request_id as stack_id
      bot.inventory.updateSlot(outputSlot, newItem);
      bot.logger.debug(`Created crafted item in slot ${outputSlot}: ${output.network_id} x${outputCount}`);
    }
  }

  /**
   * Craft with manual item placement (for when container window is open)
   */
  async function craftWithPlacement(bedrock: BedrockRecipe, baseSlot: number, gridSize: number): Promise<void> {
    const placedSlots: { craftSlot: number; count: number; stackId: number }[] = [];
    let slotIndex = 0;

    if (bedrock.type === 'shaped' || bedrock.type === 'shaped_chemistry') {
      const input = bedrock.input as RecipeIngredient[][];
      const width = bedrock.width || 1;
      const height = bedrock.height || 1;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const ing = input[y]?.[x];
          if (!ing || ing.type === 'invalid') continue;

          const craftSlot = baseSlot + y * gridSize + x;
          const srcSlots = findIngredientSlots(ing);
          if (srcSlots.length === 0) {
            throw new Error(`Missing ingredient: type=${ing.type}, id=${ing.network_id}`);
          }

          const placeResult = await placeInCraftingGrid(srcSlots[0], craftSlot, ing.count);
          if (!placeResult.success) {
            throw new Error(`Failed to place ingredient in crafting slot ${craftSlot}`);
          }
          placedSlots.push({ craftSlot, count: ing.count, stackId: placeResult.stackId });
        }
      }
    } else {
      const input = bedrock.input as RecipeIngredient[];
      for (const ing of input) {
        if (ing.type === 'invalid') continue;

        const craftSlot = baseSlot + slotIndex++;
        const srcSlots = findIngredientSlots(ing);
        if (srcSlots.length === 0) {
          throw new Error(`Missing ingredient: type=${ing.type}, id=${ing.network_id}`);
        }

        const placeResult = await placeInCraftingGrid(srcSlots[0], craftSlot, ing.count);
        if (!placeResult.success) {
          throw new Error(`Failed to place ingredient in crafting slot ${craftSlot}`);
        }
        placedSlots.push({ craftSlot, count: ing.count, stackId: placeResult.stackId });
      }
    }

    // Now send craft_recipe + consume + take
    const requestId = getNextItemStackRequestId();
    const outputCount = bedrock.output[0]?.count ?? 1;

    // Build result_items for results_deprecated based on recipe output
    const resultItems = bedrock.output.map((output) => ({
      network_id: output.network_id,
      count: output.count,
      metadata: output.metadata ?? 0,
      block_runtime_id: output.block_runtime_id ?? 0,
      extra: output.extra ?? { has_nbt: 0, can_place_on: [], can_destroy: [] },
    }));

    // Build crafting actions using ActionBuilder
    const builder = actions().craftRecipe(bedrock.networkId, 1).resultsDeprecated(resultItems, 1);

    // Add consume actions for each placed ingredient
    for (const placed of placedSlots) {
      builder.consume(placed.count, makeSlot('crafting_input', placed.craftSlot, 0));
    }

    // Take result to cursor
    builder.takeToCursor(outputCount, makeSlot('creative_output', 50, 0));

    bot.logger.info(`Sending craft_recipe: id=${requestId}, recipe=${bedrock.networkId}`);

    sendRequest(bot, requestId, builder.build());

    const success = await waitForStackResponse(requestId);
    if (!success) {
      throw new Error('Crafting failed - server rejected craft_recipe request');
    }

    await bot.putAway(0);
  }

  /**
   * Craft a recipe multiple times
   */
  async function craft(recipe: Recipe, count: number = 1, craftingTable: Block | null = null): Promise<void> {
    if (!recipe) {
      throw new Error('Recipe is required');
    }

    count = parseInt(String(count ?? 1), 10);

    if (recipe.requiresTable && !craftingTable) {
      throw new Error('Recipe requires craftingTable, but one was not supplied');
    }

    for (let i = 0; i < count; i++) {
      await craftOnce(recipe, craftingTable);
    }
  }

  // Expose API
  bot.craft = craft;
  bot.recipesFor = recipesFor;
  bot.recipesAll = recipesAll;

  // Bedrock-specific workstation APIs - use shared implementations from lib/bedrock/
  (bot as any).openStonecutter = (block: Block) => _openStonecutter(bot, block);
  (bot as any).openFurnace = (block: Block) => _openFurnace(bot, block);
  (bot as any).openEnchantmentTable = (block: Block) => _openEnchantmentTable(bot, block);
  (bot as any).openAnvil = (block: Block) => _openAnvil(bot, block);
  (bot as any).openSmithingTable = (block: Block) => _openSmithingTable(bot, block);
  (bot as any).openGrindstone = (block: Block) => _openGrindstone(bot, block);
  (bot as any).openLoom = (block: Block) => _openLoom(bot, block);
  (bot as any).openBrewingStand = (block: Block) => _openBrewingStand(bot, block);
  (bot as any).openCartographyTable = (block: Block) => _openCartographyTable(bot, block);

  // Expose recipe data for debugging
  (bot as any)._recipes = {
    byOutputId: recipesByOutputId,
    byNetworkId: recipesByNetworkId,
    unlockedRecipes,
    isRecipeUnlocked,
    get loaded() {
      return recipesLoaded;
    },
  };
}
