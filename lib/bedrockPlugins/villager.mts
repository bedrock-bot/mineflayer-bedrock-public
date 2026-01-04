/**
 * Villager Plugin - Bedrock Edition implementation for villager trading
 *
 * Provides:
 * - bot.openVillager(villagerEntity) - Opens trading UI and returns Villager window
 * - bot.trade(villager, index, count) - Execute a trade
 *
 * Bedrock Protocol:
 * - Open trade: interact {action_id: "open_inventory", target_entity_id}
 * - Server responds: container_open + update_trade
 * - Execute trade: item_stack_request with craft_recipe action
 * - Close: container_close
 *
 * Trade data comes via update_trade packet with NBT structure:
 * offers.value.Recipes.value.value = [
 *   { buyA, buyB?, sell, buyCountA, maxUses, uses, tier, traderExp, netId, ... }
 * ]
 */

import type { Entity } from 'prismarine-entity';
import type { Window } from 'prismarine-windows';
import type { BedrockBot, VillagerTrade, Villager } from '../../index.js';
import itemLoader, { type Item } from 'prismarine-item';
import { EventEmitter } from 'events';

import {
  actions,
  getNextItemStackRequestId,
  getStackId,
  sendRequest,
  waitForResponse,
  ContainerIds,
  slot as makeSlot,
  type SlotLocation,
} from '../bedrock/index.mts';

// NBT item structure from update_trade packet
interface NbtItem {
  type: string;
  value: {
    Name?: { value: string };
    Count?: { value: number };
    Damage?: { value: number };
    Block?: { value: { name?: { value: string } } };
  };
}

// Trade recipe from update_trade packet
interface NbtTradeRecipe {
  buyA?: NbtItem;
  buyB?: NbtItem;
  sell?: NbtItem;
  buyCountA?: { value: number };
  buyCountB?: { value: number };
  maxUses?: { value: number };
  uses?: { value: number };
  tier?: { value: number };
  traderExp?: { value: number };
  netId?: { value: number };
  priceMultiplierA?: { value: number };
  priceMultiplierB?: { value: number };
  demand?: { value: number };
  rewardExp?: { value: number };
}

// update_trade packet structure
interface UpdateTradePacket {
  window_id: number;
  window_type: string;
  size: number;
  trade_tier: number;
  villager_unique_id: bigint | string;
  entity_unique_id?: bigint | string;
  display_name?: string;
  new_trading_ui?: boolean;
  economic_trades?: boolean;
  offers?: {
    type: string;
    value: {
      Recipes?: {
        type: string;
        value: {
          type: string;
          value: NbtTradeRecipe[];
        };
      };
      TierExpRequirements?: any;
    };
  };
}

export default function inject(bot: BedrockBot) {
  const Item = (itemLoader as any)(bot.registry) as typeof import('prismarine-item').Item;

  // Track active trade sessions
  let activeTradeWindowId: number | null = null;
  let activeVillagerEntityId: number | bigint | null = null;

  /**
   * Parse NBT item to prismarine-item
   */
  function parseNbtItem(nbtItem: NbtItem | undefined): Item | null {
    if (!nbtItem?.value?.Name?.value) return null;

    const name = String(nbtItem.value.Name.value).replace('minecraft:', '');
    const count = nbtItem.value.Count?.value ?? 1;
    const damage = nbtItem.value.Damage?.value ?? 0;

    // Look up item in registry
    const itemDef = bot.registry.itemsByName[name];
    if (!itemDef) {
      bot.logger.warn(`Unknown item in trade: ${name}`);
      return null;
    }

    return new Item(itemDef.id, count, damage);
  }

  /**
   * Parse trades from update_trade packet
   */
  function parseTrades(packet: UpdateTradePacket): VillagerTrade[] {
    const trades: VillagerTrade[] = [];

    const recipes = packet.offers?.value?.Recipes?.value?.value;
    if (!Array.isArray(recipes)) {
      bot.logger.warn('No recipes found in update_trade packet');
      return trades;
    }

    for (const recipe of recipes) {
      const inputItem1 = parseNbtItem(recipe.buyA);
      const inputItem2 = parseNbtItem(recipe.buyB);
      const outputItem = parseNbtItem(recipe.sell);

      if (!inputItem1 || !outputItem) {
        bot.logger.warn('Invalid trade recipe - missing input or output');
        continue;
      }

      // Calculate real price based on demand and price multiplier
      const baseCost = recipe.buyCountA?.value ?? inputItem1.count;
      const demand = recipe.demand?.value ?? 0;
      const priceMultiplier = recipe.priceMultiplierA?.value ?? 0.05;
      const demandDiff = Math.max(0, Math.floor(baseCost * demand * priceMultiplier));
      const realPrice = Math.min(Math.max(baseCost + demandDiff, 1), inputItem1.stackSize || 64);

      // Override inputItem1 count with buyCountA if specified
      if (recipe.buyCountA?.value) {
        inputItem1.count = recipe.buyCountA.value;
      }

      const trade: VillagerTrade = {
        inputItem1,
        inputItem2: inputItem2 ?? null,
        outputItem,
        hasItem2: inputItem2 !== null && inputItem2.count > 0,
        tradeDisabled: (recipe.uses?.value ?? 0) >= (recipe.maxUses?.value ?? 1),
        nbTradeUses: recipe.uses?.value ?? 0,
        maximumNbTradeUses: recipe.maxUses?.value ?? 1,
        xp: recipe.traderExp?.value,
        demand: recipe.demand?.value,
        priceMultiplier: recipe.priceMultiplierA?.value,
        realPrice,
        // Bedrock-specific fields
        tier: recipe.tier?.value,
        netId: recipe.netId?.value,
        rewardExp: recipe.rewardExp?.value,
      };

      trades.push(trade);
    }

    return trades;
  }

  /**
   * Wait for update_trade packet
   */
  function waitForTradeData(windowId: number, timeout = 5000): Promise<VillagerTrade[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        bot._client.removeListener('update_trade', handler);
        reject(new Error('Timeout waiting for trade data'));
      }, timeout);

      const handler = (packet: UpdateTradePacket) => {
        if (packet.window_id === windowId) {
          clearTimeout(timer);
          bot._client.removeListener('update_trade', handler);
          const trades = parseTrades(packet);
          resolve(trades);
        }
      };

      bot._client.on('update_trade', handler);
    });
  }

  /**
   * Open villager trading window
   *
   * @param villagerEntity - The villager entity to trade with
   * @returns Villager window with trades
   */
  async function openVillager(villagerEntity: Entity): Promise<Villager> {
    // Verify entity is a villager or wandering trader
    const entityType = String(villagerEntity.type || villagerEntity.name || '');
    if (!entityType.includes('villager') && !entityType.includes('wandering_trader')) {
      throw new Error(`Entity is not a villager or trader: ${entityType}`);
    }

    // Send interact packet to open trade window
    bot._client.write('interact', {
      action_id: 'open_inventory',
      target_entity_id: villagerEntity.id,
      has_position: false,
    });

    // Wait for window to open
    const windowPromise = new Promise<Window>((resolve, reject) => {
      const timeout = setTimeout(() => {
        bot.removeListener('windowOpen', onWindowOpen);
        reject(new Error('Timeout waiting for trade window to open'));
      }, 10000);

      const onWindowOpen = (window: Window) => {
        clearTimeout(timeout);
        resolve(window);
      };

      bot.once('windowOpen', onWindowOpen);
    });

    const window = await windowPromise;
    activeTradeWindowId = window.id;
    activeVillagerEntityId = villagerEntity.id;

    // Wait for trade data
    const trades = await waitForTradeData(window.id);

    // Create Villager object extending the window
    const villager = Object.assign(window, {
      trades,
      selectedTrade: null as VillagerTrade | null,
      trade: async (index: number, count?: number) => {
        await trade(villager as any, index, count);
      },
    }) as unknown as Villager;

    // Emit ready event
    (villager as any).emit('ready');

    return villager;
  }

  /**
   * Execute a trade with a villager
   *
   * @param villager - The villager window (from openVillager)
   * @param index - Trade index to execute
   * @param count - Number of times to execute trade (default: max available)
   */
  async function trade(villager: Villager, index: number | string, count?: number): Promise<void> {
    const tradeIndex = typeof index === 'string' ? parseInt(index, 10) : index;

    if (!villager.trades || tradeIndex < 0 || tradeIndex >= villager.trades.length) {
      throw new Error(`Invalid trade index: ${tradeIndex}`);
    }

    const tradeData = villager.trades[tradeIndex];
    villager.selectedTrade = tradeData;

    // Calculate available trades
    const availableTrades = tradeData.maximumNbTradeUses - tradeData.nbTradeUses;
    if (availableTrades <= 0) {
      throw new Error('Trade is disabled (max uses reached)');
    }

    const timesToTrade = count ?? availableTrades;
    if (timesToTrade > availableTrades) {
      throw new Error(`Cannot trade ${timesToTrade} times, only ${availableTrades} available`);
    }

    // Check if we have enough items
    const realPrice = tradeData.realPrice ?? tradeData.inputItem1.count;
    const neededItem1 = realPrice * timesToTrade;
    const itemCount1 = countItems(tradeData.inputItem1.type, tradeData.inputItem1.metadata);

    if (itemCount1 < neededItem1) {
      throw new Error(`Not enough ${tradeData.inputItem1.name} to trade (need ${neededItem1}, have ${itemCount1})`);
    }

    if (tradeData.hasItem2 && tradeData.inputItem2) {
      const neededItem2 = tradeData.inputItem2.count * timesToTrade;
      const itemCount2 = countItems(tradeData.inputItem2.type, tradeData.inputItem2.metadata);
      if (itemCount2 < neededItem2) {
        throw new Error(`Not enough ${tradeData.inputItem2.name} to trade (need ${neededItem2}, have ${itemCount2})`);
      }
    }

    // Execute trade using item_stack_request
    for (let i = 0; i < timesToTrade; i++) {
      await executeOneTrade(villager, tradeData);
      tradeData.nbTradeUses++;
      if (tradeData.nbTradeUses >= tradeData.maximumNbTradeUses) {
        tradeData.tradeDisabled = true;
      }
    }
  }

  /**
   * Count items in inventory of given type
   */
  function countItems(itemType: number, metadata?: number | null): number {
    let count = 0;
    for (const item of bot.inventory.slots) {
      if (item && item.type === itemType) {
        if (metadata === null || metadata === undefined || item.metadata === metadata) {
          count += item.count;
        }
      }
    }
    return count;
  }

  /**
   * Find inventory slot with item
   */
  function findItemSlot(itemType: number, metadata?: number | null, minCount = 1): number | null {
    for (let i = 0; i < bot.inventory.slots.length; i++) {
      const item = bot.inventory.slots[i];
      if (item && item.type === itemType && item.count >= minCount) {
        if (metadata === null || metadata === undefined || item.metadata === metadata) {
          return i;
        }
      }
    }
    return null;
  }

  /**
   * Execute a single trade transaction
   *
   * Bedrock trade execution uses item_stack_request with:
   * 1. place actions to put items in trade input slots
   * 2. craft_recipe or trade action
   * 3. take action to get output
   */
  async function executeOneTrade(villager: Villager, tradeData: VillagerTrade): Promise<void> {
    const netId = (tradeData as any).netId;
    if (!netId) {
      throw new Error('Trade missing network ID - cannot execute');
    }

    // Find items in inventory
    const realPrice = tradeData.realPrice ?? tradeData.inputItem1.count;
    const slot1 = findItemSlot(tradeData.inputItem1.type, tradeData.inputItem1.metadata, realPrice);
    if (slot1 === null) {
      throw new Error(`Cannot find ${tradeData.inputItem1.name} in inventory`);
    }

    const item1 = bot.inventory.slots[slot1]!;
    const stackId1 = getStackId(item1);

    let slot2: number | null = null;
    let item2: Item | null = null;
    let stackId2 = 0;

    if (tradeData.hasItem2 && tradeData.inputItem2) {
      slot2 = findItemSlot(tradeData.inputItem2.type, tradeData.inputItem2.metadata, tradeData.inputItem2.count);
      if (slot2 === null) {
        throw new Error(`Cannot find ${tradeData.inputItem2.name} in inventory`);
      }
      item2 = bot.inventory.slots[slot2]!;
      stackId2 = getStackId(item2);
    }

    // Find empty slot for output
    let outputSlot = -1;
    for (let i = 0; i < 36; i++) {
      if (!bot.inventory.slots[i]) {
        outputSlot = i;
        break;
      }
    }
    if (outputSlot === -1) {
      throw new Error('No empty inventory slot for trade output');
    }

    // Build trade request
    // Trade slots: 0 = input1, 1 = input2, 2 = output
    const requestId = getNextItemStackRequestId();
    const outputCount = tradeData.outputItem.count;

    // Build result items for results_deprecated
    const resultItems = [
      {
        network_id: tradeData.outputItem.type,
        count: outputCount,
        metadata: tradeData.outputItem.metadata ?? 0,
        block_runtime_id: 0,
        extra: { has_nbt: 0, can_place_on: [], can_destroy: [] },
      },
    ];

    // Use craft_recipe action with consume and place actions
    // From packet captures, villager trades use similar format to crafting
    const builder = actions()
      .craftRecipe(netId, 1)
      .resultsDeprecated(resultItems, 1)
      .consume(realPrice, makeSlot('hotbar_and_inventory', slot1, stackId1));

    if (tradeData.hasItem2 && tradeData.inputItem2 && slot2 !== null) {
      builder.consume(tradeData.inputItem2.count, makeSlot('hotbar_and_inventory', slot2, stackId2));
    }

    // Place output directly to inventory
    builder.place(outputCount, makeSlot('creative_output', 50, requestId), makeSlot('hotbar_and_inventory', outputSlot, 0));

    bot.logger.debug(`Executing trade: netId=${netId}, requestId=${requestId}`);

    sendRequest(bot, requestId, builder.build());

    const success = await waitForResponse(bot, requestId);
    if (!success) {
      throw new Error('Trade failed - server rejected request');
    }

    // Create output item in destination slot
    const newItem = new Item(tradeData.outputItem.type, outputCount, tradeData.outputItem.metadata ?? 0);
    (newItem as any).stackId = requestId;
    bot.inventory.updateSlot(outputSlot, newItem);

    bot.logger.debug(`Trade successful: ${tradeData.outputItem.name} x${outputCount} → slot ${outputSlot}`);
  }

  // Listen for trade window close
  bot._client.on('container_close', (packet: { window_id: number }) => {
    if (packet.window_id === activeTradeWindowId) {
      activeTradeWindowId = null;
      activeVillagerEntityId = null;
    }
  });

  // Expose API
  bot.openVillager = openVillager;
  bot.trade = trade;
}
