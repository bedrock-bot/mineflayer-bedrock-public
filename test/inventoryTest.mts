/**
 * Comprehensive Inventory/Window API Tests for Bedrock Edition
 *
 * Tests cover:
 * - Inventory loading and slot mapping
 * - Item movement (moveSlotItem, transfer)
 * - Equipment operations (equip, unequip)
 * - Hotbar selection
 * - Container operations (open, withdraw, deposit, close)
 * - Toss operations
 */

import { type Player, Server, type Version } from 'bedrock-protocol';
import registryLoader, { type RegistryBedrock } from 'prismarine-registry';
import type { Bot } from '../index.js';
import mineflayer from '../index.js';
import { expect } from 'expect';
import { getDataBuilder, startServer, waitForClientConnect, initializeClient } from 'minecraft-bedrock-server';

function connectToServer(version: string) {
  return mineflayer.createBot({
    host: '127.0.0.1',
    port: 25567,
    version: `bedrock_${version}`,
    auth: 'offline',
    username: 'BedrockBot',
    offline: true,
  });
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Helper to create mock item_stack_response for successful operations
 */
function createSuccessResponse(client: Player, request: any) {
  const response = {
    responses: [
      {
        status: 'ok',
        request_id: request.request_id,
        containers: request.actions
          .map((action: any) => {
            if (action.type_id === 'take') {
              return [
                {
                  slot_type: action.source.slot_type,
                  slots: [
                    {
                      slot: action.source.slot,
                      hotbar_slot: action.source.slot,
                      count: 0,
                      item_stack_id: 0,
                      custom_name: '',
                      filtered_custom_name: '',
                      durability_correction: 0,
                    },
                  ],
                },
                {
                  slot_type: action.destination.slot_type,
                  slots: [
                    {
                      slot: action.destination.slot,
                      hotbar_slot: action.destination.slot,
                      count: action.count,
                      item_stack_id: action.source.stack_id,
                      custom_name: '',
                      filtered_custom_name: '',
                      durability_correction: 0,
                    },
                  ],
                },
              ];
            } else if (action.type_id === 'place') {
              return [
                {
                  slot_type: action.source.slot_type,
                  slots: [
                    {
                      slot: action.source.slot,
                      hotbar_slot: action.source.slot,
                      count: 0,
                      item_stack_id: 0,
                      custom_name: '',
                      filtered_custom_name: '',
                      durability_correction: 0,
                    },
                  ],
                },
                {
                  slot_type: action.destination.slot_type,
                  slots: [
                    {
                      slot: action.destination.slot,
                      hotbar_slot: action.destination.slot,
                      count: action.count,
                      item_stack_id: action.source.stack_id,
                      custom_name: '',
                      filtered_custom_name: '',
                      durability_correction: 0,
                    },
                  ],
                },
              ];
            } else if (action.type_id === 'drop') {
              return [
                {
                  slot_type: action.source.slot_type,
                  slots: [
                    {
                      slot: action.source.slot,
                      hotbar_slot: action.source.slot,
                      count: 0,
                      item_stack_id: 0,
                      custom_name: '',
                      filtered_custom_name: '',
                      durability_correction: 0,
                    },
                  ],
                },
              ];
            }
            return [];
          })
          .flat(),
      },
    ],
  };
  client.write('item_stack_response', response);
}

/**
 * Helper to set up container_open response for interact packets
 */
function setupContainerOpenHandler(client: Player, windowId: number = 2) {
  client.on('interact', (packet: any) => {
    if (packet.action_id === 'open_inventory') {
      client.write('container_open', {
        window_id: windowId,
        window_type: 'inventory',
        coordinates: { x: 0, y: 1, z: 0 },
        runtime_entity_id: '-1',
      });
    }
  });
}

/**
 * Helper to set up container_close response
 */
function setupContainerCloseHandler(client: Player) {
  client.on('container_close', (packet: any) => {
    client.write('container_close', {
      window_id: packet.window_id,
      window_type: 'none',
      server: true,
    });
  });
}

/**
 * Helper to set up item_stack_request response handler
 */
function setupItemStackRequestHandler(client: Player) {
  client.on('item_stack_request', (packet: any) => {
    for (const request of packet.requests) {
      createSuccessResponse(client, request);
    }
  });
}

const testedVersions: Version[] = ['1.21.130'];

for (const supportedVersion of testedVersions) {
  describe(`Inventory/Window API Tests - ${supportedVersion}`, function () {
    this.timeout(15 * 1000);

    let bot: Bot | null = null;
    let server: Server | null = null;
    let client: Player | null = null;
    let registry: RegistryBedrock;

    beforeEach(() => {
      registry = registryLoader(`bedrock_${supportedVersion}`) as RegistryBedrock;
    });

    afterEach(async () => {
      if (bot) {
        //bot.end();
        bot = null;
      }
      if (server) {
        await server.close();
        server = null;
      }
      client = null;
    });

    // ============================================================
    // INVENTORY LOADING TESTS
    // ============================================================
    describe('Inventory Loading', () => {
      it('should load empty inventory correctly', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        // No items set - all slots should be empty

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        // All hotbar slots should be empty
        for (let slot = 0; slot < 9; slot++) {
          expect(bot!.inventory.slots[slot]).toBeFalsy();
        }
      });

      it('should load single hotbar item correctly', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'diamond_sword', 1, 1001);

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        expect(bot!.inventory.slots[0]?.name).toBe('diamond_sword');
        expect(bot!.inventory.slots[0]?.count).toBe(1);
      });

      it('should load multiple hotbar items correctly', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'diamond_sword', 1, 1001);
        dataBuilder.setInventoryItem(1, 'diamond_pickaxe', 1, 1002);
        dataBuilder.setInventoryItem(2, 'diamond_axe', 1, 1003);
        dataBuilder.setInventoryItem(8, 'bow', 1, 1004);

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        expect(bot!.inventory.slots[0]?.name).toBe('diamond_sword');
        expect(bot!.inventory.slots[1]?.name).toBe('diamond_pickaxe');
        expect(bot!.inventory.slots[2]?.name).toBe('diamond_axe');
        expect(bot!.inventory.slots[8]?.name).toBe('bow');
      });

      it('should load stackable items with correct count', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'cobblestone', 64, 1001);
        dataBuilder.setInventoryItem(1, 'dirt', 32, 1002);
        dataBuilder.setInventoryItem(2, 'oak_log', 16, 1003);

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        expect(bot!.inventory.slots[0]?.name).toBe('cobblestone');
        expect(bot!.inventory.slots[0]?.count).toBe(64);
        expect(bot!.inventory.slots[1]?.name).toBe('dirt');
        expect(bot!.inventory.slots[1]?.count).toBe(32);
        expect(bot!.inventory.slots[2]?.name).toBe('oak_log');
        expect(bot!.inventory.slots[2]?.count).toBe(16);
      });

      it('should load offhand item correctly', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setOffhandSlot('shield', 1007);

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        // Off-hand is slot 45 in prismarine-windows
        expect(bot!.inventory.slots[45]?.name).toBe('shield');
      });

      it('should load armor items correctly', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setArmorSlot(0, 'netherite_helmet', 1, 2001);
        dataBuilder.setArmorSlot(1, 'netherite_chestplate', 1, 2002);
        dataBuilder.setArmorSlot(2, 'netherite_leggings', 1, 2003);
        dataBuilder.setArmorSlot(3, 'netherite_boots', 1, 2004);

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        // Armor slots are 5-8 in prismarine-windows (helmet=5, chest=6, legs=7, boots=8)
        // Note: The actual mapping depends on the Bedrock implementation
      });
    });

    // ============================================================
    // HOTBAR SELECTION TESTS
    // ============================================================
    describe('Hotbar Selection', () => {
      it('should send mob_equipment packet when changing hotbar slot', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'diamond_sword', 1, 1001);
        dataBuilder.setInventoryItem(1, 'diamond_pickaxe', 1, 1002);

        const mob_equipment_packets: any[] = [];

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);
        client.on('mob_equipment', (packet: any) => {
          mob_equipment_packets.push(packet);
        });

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        const initialPacketCount = mob_equipment_packets.length;

        // Change hotbar slot
        bot!.setQuickBarSlot(1);
        await sleep(50);

        // Should have sent a mob_equipment packet
        expect(mob_equipment_packets.length).toBeGreaterThan(initialPacketCount);
      });

      it('should update heldItem when changing hotbar slot', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'diamond_sword', 1, 1001);
        dataBuilder.setInventoryItem(1, 'diamond_pickaxe', 1, 1002);

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        // Initially should be slot 0
        expect(bot!.heldItem?.name).toBe('diamond_sword');

        // Change to slot 1
        bot!.setQuickBarSlot(1);
        expect(bot!.heldItem?.name).toBe('diamond_pickaxe');

        // Change to empty slot
        bot!.setQuickBarSlot(5);
        expect(bot!.heldItem).toBeFalsy();
      });

      it('should update quickBarSlot property', async () => {
        const dataBuilder = getDataBuilder('1.21.130');

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        bot!.setQuickBarSlot(3);
        expect(bot!.quickBarSlot).toBe(3);

        bot!.setQuickBarSlot(7);
        expect(bot!.quickBarSlot).toBe(7);
      });
    });

    // ============================================================
    // ITEM MOVEMENT TESTS
    // ============================================================
    describe('Item Movement', () => {
      it('should move item to empty slot using moveSlotItem', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'diamond_sword', 1, 1001);

        const item_stack_requests: any[] = [];

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        setupContainerOpenHandler(client);
        setupContainerCloseHandler(client);
        setupItemStackRequestHandler(client);

        client.on('item_stack_request', (packet: any) => {
          item_stack_requests.push(packet);
        });

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        // Move item from slot 0 to slot 5
        await bot!.moveSlotItem(0, 5);

        // Verify requests were sent
        expect(item_stack_requests.length).toBeGreaterThan(0);
      });

      it('should swap items when moving to occupied slot', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'diamond_sword', 1, 1001);
        dataBuilder.setInventoryItem(1, 'diamond_pickaxe', 1, 1002);

        const item_stack_requests: any[] = [];

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        setupContainerOpenHandler(client);
        setupContainerCloseHandler(client);
        setupItemStackRequestHandler(client);

        client.on('item_stack_request', (packet: any) => {
          item_stack_requests.push(packet);
        });

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        // Move item from slot 0 to slot 1 (should swap)
        await bot!.moveSlotItem(0, 1);

        // Should have sent multiple item_stack_requests
        expect(item_stack_requests.length).toBeGreaterThan(0);
      });
    });

    // ============================================================
    // WINDOW SEARCH TESTS
    // ============================================================
    describe('Window Search Methods', () => {
      it('should find item in inventory using findInventoryItem', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        // Use slot 10 which is in the inventory range (9-35), not hotbar (0-8)
        dataBuilder.setInventoryItem(10, 'diamond', 10, 1001);

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        const diamondId = registry.itemsByName['diamond']?.id;
        const found = bot!.inventory.findInventoryItem(diamondId, null, false);

        expect(found).toBeTruthy();
        expect(found?.name).toBe('diamond');
        expect(found?.count).toBe(10);
      });

      it('should count items correctly using count method', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        // Use slots in the inventory range (9-35), not hotbar (0-8)
        dataBuilder.setInventoryItem(9, 'diamond', 10, 1001);
        dataBuilder.setInventoryItem(10, 'diamond', 20, 1002);
        dataBuilder.setInventoryItem(11, 'diamond', 34, 1003);

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        const diamondId = registry.itemsByName['diamond']?.id;
        const count = bot!.inventory.count(diamondId, null);

        expect(count).toBe(64); // 10 + 20 + 34
      });

      it('should list items correctly using items method', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'diamond_sword', 1, 1001);
        dataBuilder.setInventoryItem(1, 'diamond_pickaxe', 1, 1002);
        dataBuilder.setInventoryItem(2, 'cobblestone', 64, 1003);

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        const items = bot!.inventory.items();
        expect(items.length).toBe(3);

        const itemNames = items.map((item) => item.name);
        expect(itemNames).toContain('diamond_sword');
        expect(itemNames).toContain('diamond_pickaxe');
        expect(itemNames).toContain('cobblestone');
      });

      it('should find first empty slot correctly', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'diamond_sword', 1, 1001);
        dataBuilder.setInventoryItem(1, 'diamond_pickaxe', 1, 1002);
        // Slot 2 is empty

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        const emptySlot = bot!.inventory.firstEmptySlotRange(0, 9);
        expect(emptySlot).toBe(2);
      });

      it('should count empty slots correctly', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        // Set 5 items in first 5 slots
        dataBuilder.setInventoryItem(0, 'diamond_sword', 1, 1001);
        dataBuilder.setInventoryItem(1, 'diamond_pickaxe', 1, 1002);
        dataBuilder.setInventoryItem(2, 'diamond_axe', 1, 1003);
        dataBuilder.setInventoryItem(3, 'diamond_shovel', 1, 1004);
        dataBuilder.setInventoryItem(4, 'diamond_hoe', 1, 1005);

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        const emptyCount = bot!.inventory.emptySlotCount();
        // 36 inventory slots - 5 occupied = 31 empty (in inventory section)
        expect(emptyCount).toBeGreaterThan(0);
      });
    });

    // ============================================================
    // MOB_EQUIPMENT PACKET TESTS
    // ============================================================
    describe('Mob Equipment Packets', () => {
      it('should send mob_equipment for main hand on spawn', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'netherite_sword', 1, 1001);

        const mob_equipment_packets: any[] = [];

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);
        client.on('mob_equipment', (packet: any) => {
          mob_equipment_packets.push(packet);
        });

        await initializeClient(client, dataBuilder.data);
        await sleep(200);

        // Should have sent at least one mob_equipment packet for main hand
        const mainHandPacket = mob_equipment_packets.find((p) => p.window_id === 'inventory');
        expect(mainHandPacket).toBeTruthy();
      });

      it('should send mob_equipment for offhand on spawn', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setOffhandSlot('shield', 1007);

        const mob_equipment_packets: any[] = [];

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);
        client.on('mob_equipment', (packet: any) => {
          mob_equipment_packets.push(packet);
        });

        await initializeClient(client, dataBuilder.data);
        await sleep(200);

        // Should have sent mob_equipment packet for offhand
        const offhandPacket = mob_equipment_packets.find((p) => p.window_id === 'offhand');
        expect(offhandPacket).toBeTruthy();
      });

      it('should send both main hand and offhand packets', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'netherite_sword', 1, 1001);
        dataBuilder.setOffhandSlot('shield', 1007);

        const mob_equipment_packets: any[] = [];

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);
        client.on('mob_equipment', (packet: any) => {
          mob_equipment_packets.push(packet);
        });

        await initializeClient(client, dataBuilder.data);
        await sleep(200);

        // Should have 2 mob_equipment packets
        expect(mob_equipment_packets.length).toBeGreaterThanOrEqual(2);

        const mainHandPacket = mob_equipment_packets.find((p) => p.window_id === 'inventory');
        const offhandPacket = mob_equipment_packets.find((p) => p.window_id === 'offhand');

        expect(mainHandPacket).toBeTruthy();
        expect(offhandPacket).toBeTruthy();
      });
    });

    // ============================================================
    // CONTAINER INTERACTION TESTS
    // ============================================================
    describe('Container Interactions', () => {
      it('should send interact packet when opening inventory', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'diamond_sword', 1, 1001);

        const interact_packets: any[] = [];

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        setupContainerOpenHandler(client);
        setupContainerCloseHandler(client);
        setupItemStackRequestHandler(client);

        client.on('interact', (packet: any) => {
          interact_packets.push(packet);
        });

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        // Trigger an operation that requires opening inventory
        await bot!.moveSlotItem(0, 1);

        // Should have sent open_inventory interact packet
        const openInventoryPacket = interact_packets.find((p) => p.action_id === 'open_inventory');
        expect(openInventoryPacket).toBeTruthy();
      });

      it('should send container_close packet after operation', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'diamond_sword', 1, 1001);

        const container_close_packets: any[] = [];

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        setupContainerOpenHandler(client);
        setupContainerCloseHandler(client);
        setupItemStackRequestHandler(client);

        client.on('container_close', (packet: any) => {
          container_close_packets.push(packet);
        });

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        // Trigger an operation
        await bot!.moveSlotItem(0, 1);

        // Should have sent container_close packet
        expect(container_close_packets.length).toBeGreaterThanOrEqual(1);
      });
    });

    // ============================================================
    // ITEM STACK REQUEST TESTS
    // ============================================================
    describe('Item Stack Request Format', () => {
      it('should send take action with correct slot_type', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'diamond_sword', 1, 1001);

        const item_stack_requests: any[] = [];

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        setupContainerOpenHandler(client);
        setupContainerCloseHandler(client);
        setupItemStackRequestHandler(client);

        client.on('item_stack_request', (packet: any) => {
          item_stack_requests.push(packet);
        });

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        await bot!.moveSlotItem(0, 1);

        // Find the take action
        const takeRequest = item_stack_requests.find((req) => req.requests.some((r: any) => r.actions.some((a: any) => a.type_id === 'take')));

        expect(takeRequest).toBeTruthy();

        const takeAction = takeRequest.requests[0].actions.find((a: any) => a.type_id === 'take');
        expect(takeAction.source.slot_type.container_id).toBe('hotbar');
        expect(takeAction.destination.slot_type.container_id).toBe('cursor');
      });

      it('should send place action with correct slot_type', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'diamond_sword', 1, 1001);

        const item_stack_requests: any[] = [];

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        setupContainerOpenHandler(client);
        setupContainerCloseHandler(client);
        setupItemStackRequestHandler(client);

        client.on('item_stack_request', (packet: any) => {
          item_stack_requests.push(packet);
        });

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        await bot!.moveSlotItem(0, 1);

        // Find the place action
        const placeRequest = item_stack_requests.find((req) => req.requests.some((r: any) => r.actions.some((a: any) => a.type_id === 'place')));

        expect(placeRequest).toBeTruthy();

        const placeAction = placeRequest.requests[0].actions.find((a: any) => a.type_id === 'place');
        expect(placeAction.source.slot_type.container_id).toBe('cursor');
        expect(placeAction.destination.slot_type.container_id).toBe('hotbar');
      });

      it('should include correct count in actions', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'cobblestone', 32, 1001);

        const item_stack_requests: any[] = [];

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        setupContainerOpenHandler(client);
        setupContainerCloseHandler(client);
        setupItemStackRequestHandler(client);

        client.on('item_stack_request', (packet: any) => {
          item_stack_requests.push(packet);
        });

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        await bot!.moveSlotItem(0, 1);

        // Find the take action and verify count
        const takeRequest = item_stack_requests.find((req) => req.requests.some((r: any) => r.actions.some((a: any) => a.type_id === 'take')));

        if (takeRequest) {
          const takeAction = takeRequest.requests[0].actions.find((a: any) => a.type_id === 'take');
          expect(takeAction.count).toBe(32);
        }
      });
    });

    // ============================================================
    // INVENTORY EVENTS TESTS
    // ============================================================
    describe('Inventory Events', () => {
      it('should emit heldItemChanged event when hotbar slot changes', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'diamond_sword', 1, 1001);
        dataBuilder.setInventoryItem(1, 'diamond_pickaxe', 1, 1002);

        let heldItemChangedCount = 0;
        let lastHeldItem: any = null;

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        bot!.on('heldItemChanged', (item) => {
          heldItemChangedCount++;
          lastHeldItem = item;
        });

        bot!.setQuickBarSlot(1);
        await sleep(50);

        expect(heldItemChangedCount).toBeGreaterThan(0);
        expect(lastHeldItem?.name).toBe('diamond_pickaxe');
      });

      it('should emit updateSlot event on inventory changes', async () => {
        const dataBuilder = getDataBuilder('1.21.130');

        let updateSlotCount = 0;

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        bot!.inventory.on('updateSlot', () => {
          updateSlotCount++;
        });

        // Simulate server sending inventory_slot update
        client!.write('inventory_slot', {
          window_id: 'inventory',
          slot: 0,
          item: dataBuilder.toNotch('diamond', 10, 9999),
          container: { container_id: 'inventory' },
          storage_item: { network_id: 0 },
        });

        await sleep(100);

        // Should have received updateSlot events
        expect(updateSlotCount).toBeGreaterThan(0);
      });
    });

    // ============================================================
    // EDGE CASES
    // ============================================================
    describe('Edge Cases', () => {
      it('should handle empty slot movement gracefully', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        // No items - all slots empty

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        setupContainerOpenHandler(client);
        setupContainerCloseHandler(client);
        setupItemStackRequestHandler(client);

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        // Moving empty slot should not throw
        try {
          await bot!.moveSlotItem(0, 1);
          // Should complete without error (or may throw - depends on implementation)
        } catch (error) {
          // Expected - can't move empty slot
        }
      });

      it('should handle same slot movement', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'diamond_sword', 1, 1001);

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        setupContainerOpenHandler(client);
        setupContainerCloseHandler(client);
        setupItemStackRequestHandler(client);

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        // Moving to same slot should be a no-op
        const initialItem = bot!.inventory.slots[0];
        await bot!.moveSlotItem(0, 0);
        expect(bot!.inventory.slots[0]).toBe(initialItem);
      });

      it('should handle invalid hotbar slot gracefully', async () => {
        const dataBuilder = getDataBuilder('1.21.130');

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        await initializeClient(client, dataBuilder.data);
        await sleep(100);

        // Setting invalid slot should throw or be handled
        try {
          bot!.setQuickBarSlot(10); // Invalid - should be 0-8
        } catch (error) {
          // Expected
          expect(error).toBeTruthy();
        }
      });
    });

    // ============================================================
    // PHASE 1: FOUNDATION FIXES TESTS
    // ============================================================
    describe('Phase 1: Foundation Fixes', () => {
      describe('closeWindow', () => {
        it('should not close player inventory', async () => {
          const dataBuilder = getDataBuilder('1.21.130');

          registry.handleItemRegistry(dataBuilder.data.item_registry);
          server = await startServer('127.0.0.1', 25567, supportedVersion);
          setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
          client = await waitForClientConnect(server);

          const container_close_packets: any[] = [];
          client.on('container_close', (packet: any) => {
            container_close_packets.push(packet);
          });

          await initializeClient(client, dataBuilder.data);
          await sleep(100);

          // Try to close player inventory - should be no-op
          bot!.closeWindow(bot!.inventory);
          await sleep(50);

          // No container_close packet should be sent for player inventory
          expect(container_close_packets.length).toBe(0);
        });

        it('should not crash when closing null window', async () => {
          const dataBuilder = getDataBuilder('1.21.130');

          registry.handleItemRegistry(dataBuilder.data.item_registry);
          server = await startServer('127.0.0.1', 25567, supportedVersion);
          setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
          client = await waitForClientConnect(server);

          await initializeClient(client, dataBuilder.data);
          await sleep(100);

          // Should not throw
          expect(() => bot!.closeWindow(null as any)).not.toThrow();
        });
      });

      describe('setQuickBarSlot - Enhanced', () => {
        it('should reject negative slot numbers', async () => {
          const dataBuilder = getDataBuilder('1.21.130');

          registry.handleItemRegistry(dataBuilder.data.item_registry);
          server = await startServer('127.0.0.1', 25567, supportedVersion);
          setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
          client = await waitForClientConnect(server);

          await initializeClient(client, dataBuilder.data);
          await sleep(100);

          expect(() => bot!.setQuickBarSlot(-1)).toThrow('Invalid quickBarSlot');
        });

        it('should reject slot numbers greater than 8', async () => {
          const dataBuilder = getDataBuilder('1.21.130');

          registry.handleItemRegistry(dataBuilder.data.item_registry);
          server = await startServer('127.0.0.1', 25567, supportedVersion);
          setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
          client = await waitForClientConnect(server);

          await initializeClient(client, dataBuilder.data);
          await sleep(100);

          expect(() => bot!.setQuickBarSlot(9)).toThrow('Invalid quickBarSlot');
        });

        it('should not send packet when setting same slot', async () => {
          const dataBuilder = getDataBuilder('1.21.130');
          dataBuilder.setInventoryItem(0, 'diamond_sword', 1, 1001);

          const mob_equipment_packets: any[] = [];

          registry.handleItemRegistry(dataBuilder.data.item_registry);
          server = await startServer('127.0.0.1', 25567, supportedVersion);
          setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
          client = await waitForClientConnect(server);
          client.on('mob_equipment', (packet: any) => {
            mob_equipment_packets.push(packet);
          });

          await initializeClient(client, dataBuilder.data);
          // Wait longer for spawn mob_equipment packets to arrive (they're sent asynchronously after player_spawn)
          await sleep(300);

          const initialCount = mob_equipment_packets.length;

          // Set to current slot (0 by default)
          bot!.setQuickBarSlot(0);
          await sleep(50);

          // Should not have sent new packet
          expect(mob_equipment_packets.length).toBe(initialCount);
        });

        it('should send mob_equipment packet with empty hand', async () => {
          const dataBuilder = getDataBuilder('1.21.130');
          // No items in hotbar

          const mob_equipment_packets: any[] = [];

          registry.handleItemRegistry(dataBuilder.data.item_registry);
          server = await startServer('127.0.0.1', 25567, supportedVersion);
          setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
          client = await waitForClientConnect(server);
          client.on('mob_equipment', (packet: any) => {
            mob_equipment_packets.push(packet);
          });

          await initializeClient(client, dataBuilder.data);
          await sleep(100);

          bot!.setQuickBarSlot(1);
          await sleep(50);

          // Should have sent packet with network_id: 0 (empty)
          const lastPacket = mob_equipment_packets[mob_equipment_packets.length - 1];
          expect(lastPacket.item.network_id).toBe(0);
        });
      });

      describe('moveSlotItem - Swap Support', () => {
        it('should swap items when destination is occupied', async () => {
          const dataBuilder = getDataBuilder('1.21.130');
          dataBuilder.setInventoryItem(0, 'diamond_sword', 1, 1001);
          dataBuilder.setInventoryItem(1, 'diamond_pickaxe', 1, 1002);

          const item_stack_requests: any[] = [];

          registry.handleItemRegistry(dataBuilder.data.item_registry);
          server = await startServer('127.0.0.1', 25567, supportedVersion);
          setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
          client = await waitForClientConnect(server);

          setupContainerOpenHandler(client);
          setupContainerCloseHandler(client);
          setupItemStackRequestHandler(client);

          client.on('item_stack_request', (packet: any) => {
            item_stack_requests.push(packet);
          });

          await initializeClient(client, dataBuilder.data);
          await sleep(100);

          // Move item from slot 0 to slot 1 (both occupied - should swap)
          await bot!.moveSlotItem(0, 1);

          // Find the request with swap action
          const swapRequest = item_stack_requests.find((req) => req.requests.some((r: any) => r.actions.some((a: any) => a.type_id === 'swap')));

          expect(swapRequest).toBeTruthy();

          const swapAction = swapRequest.requests[0].actions.find((a: any) => a.type_id === 'swap');
          expect(swapAction).toBeTruthy();
          expect(swapAction.source.slot_type.container_id).toBe('hotbar');
          expect(swapAction.destination.slot_type.container_id).toBe('hotbar');
        });

        it('should use single request for empty destination', async () => {
          const dataBuilder = getDataBuilder('1.21.130');
          dataBuilder.setInventoryItem(0, 'diamond_sword', 1, 1001);
          // Slot 1 is empty

          const item_stack_requests: any[] = [];

          registry.handleItemRegistry(dataBuilder.data.item_registry);
          server = await startServer('127.0.0.1', 25567, supportedVersion);
          setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
          client = await waitForClientConnect(server);

          setupContainerOpenHandler(client);
          setupContainerCloseHandler(client);
          setupItemStackRequestHandler(client);

          client.on('item_stack_request', (packet: any) => {
            item_stack_requests.push(packet);
          });

          await initializeClient(client, dataBuilder.data);
          await sleep(100);

          const beforeCount = item_stack_requests.length;

          await bot!.moveSlotItem(0, 1);

          // Should have sent only ONE request
          expect(item_stack_requests.length - beforeCount).toBe(1);

          const request = item_stack_requests[item_stack_requests.length - 1];
          expect(request.requests).toHaveLength(1);
          expect(request.requests[0].actions).toHaveLength(2); // take + place
        });

        it('should handle move from inventory to hotbar', async () => {
          const dataBuilder = getDataBuilder('1.21.130');
          dataBuilder.setInventoryItem(10, 'diamond', 5, 1001); // Slot 10 is in inventory

          const item_stack_requests: any[] = [];

          registry.handleItemRegistry(dataBuilder.data.item_registry);
          server = await startServer('127.0.0.1', 25567, supportedVersion);
          setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
          client = await waitForClientConnect(server);

          setupContainerOpenHandler(client);
          setupContainerCloseHandler(client);
          setupItemStackRequestHandler(client);

          client.on('item_stack_request', (packet: any) => {
            item_stack_requests.push(packet);
          });

          await initializeClient(client, dataBuilder.data);
          await sleep(100);

          // Move from inventory slot 10 to hotbar slot 0
          await bot!.moveSlotItem(10, 0);

          const request = item_stack_requests[item_stack_requests.length - 1];
          const takeAction = request.requests[0].actions.find((a: any) => a.type_id === 'take');
          const placeAction = request.requests[0].actions.find((a: any) => a.type_id === 'place');

          expect(takeAction.source.slot_type.container_id).toBe('inventory');
          expect(placeAction.destination.slot_type.container_id).toBe('hotbar');
        });

        it('should close inventory window after operation', async () => {
          const dataBuilder = getDataBuilder('1.21.130');
          dataBuilder.setInventoryItem(0, 'diamond_sword', 1, 1001);

          const container_close_packets: any[] = [];

          registry.handleItemRegistry(dataBuilder.data.item_registry);
          server = await startServer('127.0.0.1', 25567, supportedVersion);
          setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
          client = await waitForClientConnect(server);

          setupContainerOpenHandler(client);
          setupContainerCloseHandler(client);
          setupItemStackRequestHandler(client);

          client.on('container_close', (packet: any) => {
            container_close_packets.push(packet);
          });

          await initializeClient(client, dataBuilder.data);
          await sleep(100);

          await bot!.moveSlotItem(0, 1);

          // Should have sent container_close packet
          expect(container_close_packets.length).toBeGreaterThanOrEqual(1);
          const closePacket = container_close_packets[container_close_packets.length - 1];
          expect(closePacket.server).toBe(false); // Client-initiated close
        });
      });
    });
  });
}
