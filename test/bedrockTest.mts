import { type Player, Server, type Version } from 'bedrock-protocol';
import registryLoader, { type RegistryBedrock } from 'prismarine-registry';
import type { Bot } from '../index.js';
import mineflayer from '../index.js';
import { expect } from 'expect';
import { getDataBuilder, startServer, waitForClientConnect, initializeClient } from 'minecraft-bedrock-test-server';

function connectToServer(version) {
  return mineflayer.createBot({
    host: '127.0.0.1',
    port: 25567,
    version: `bedrock_${version}`,
    auth: 'offline',
    username: 'BedrockBot',
    offline: true,
  });
}

const testedVersions: Version[] = ['1.21.130'];
for (const supportedVersion of testedVersions) {
  describe(`mineflayer_internal ${supportedVersion}v`, function () {
    this.timeout(15 * 1000);

    let bot: Bot | null = null;
    let server: Server | null = null;
    let client: Player | null = null;

    let registry = registryLoader(`bedrock_${supportedVersion}`) as RegistryBedrock;

    // Test that the bot sends the correct mob_equipment packets after receiving play_status
    xit('sends correct mob_equipment packets after play_status', async () => {
      const dataBuilder = getDataBuilder('1.21.130');
      dataBuilder.setInventoryItem(0, 'netherite_sword', 1, 1001);
      dataBuilder.setInventoryItem(1, 'netherite_chestplate', 1, 1002);
      dataBuilder.setInventoryItem(2, 'netherite_leggings', 1, 1003);
      dataBuilder.setInventoryItem(3, 'netherite_sword', 1, 1004);
      dataBuilder.setInventoryItem(8, 'netherite_sword', 1, 1005);
      dataBuilder.setInventoryItem(9, 'jungle_log', 64, 1006);
      dataBuilder.setOffhandSlot('shield', 1007);

      const mob_equipment_packets = [];
      registry.handleItemRegistry(dataBuilder.data.item_registry);
      server = await startServer('127.0.0.1', 25567, supportedVersion);
      setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
      client = await waitForClientConnect(server);
      client.on('mob_equipment', (x) => {
        mob_equipment_packets.push(x);
      });

      await initializeClient(client, dataBuilder.data);

      expect(mob_equipment_packets).toHaveLength(2);

      expect(mob_equipment_packets[0]).toEqual(
        dataBuilder.normalizePacket('mob_equipment', {
          item: dataBuilder.toNotch('netherite_sword', 1, undefined),
          runtime_entity_id: 25n,
          selected_slot: 0,
          slot: 0,
          window_id: 'inventory',
        })
      );

      expect(mob_equipment_packets[1]).toEqual(
        dataBuilder.normalizePacket('mob_equipment', {
          item: dataBuilder.toNotch('shield', 1, undefined),
          runtime_entity_id: 25n,
          selected_slot: 0,
          slot: 1,
          window_id: 'offhand',
        })
      );
    });

    xit('should load invenory items', async () => {
      const dataBuilder = getDataBuilder('1.21.130');

      for (let slot = 0; slot < 36; slot++) {
        const count = slot + 1;
        dataBuilder.setInventoryItem(slot, 'jungle_log', count, 1000 + slot);
      }

      dataBuilder.setOffhandSlot('shield', 1007);

      const mob_equipment_packets = [];
      registry.handleItemRegistry(dataBuilder.data.item_registry);
      server = await startServer('127.0.0.1', 25567, supportedVersion);
      setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
      client = await waitForClientConnect(server);
      client.on('mob_equipment', (x) => {
        mob_equipment_packets.push(x);
      });

      await initializeClient(client, dataBuilder.data);

      const actual = bot.inventory.slots.map((x) => `${x?.count - 1} ${x?.name}`.trim());
      expect(actual).toEqual([
        '0 jungle_log',
        '1 jungle_log',
        '2 jungle_log',
        '3 jungle_log',
        '4 jungle_log',
        '5 jungle_log',
        '6 jungle_log',
        '7 jungle_log',
        '8 jungle_log',
        '9 jungle_log',
        '10 jungle_log',
        '11 jungle_log',
        '12 jungle_log',
        '13 jungle_log',
        '14 jungle_log',
        '15 jungle_log',
        '16 jungle_log',
        '17 jungle_log',
        '18 jungle_log',
        '19 jungle_log',
        '20 jungle_log',
        '21 jungle_log',
        '22 jungle_log',
        '23 jungle_log',
        '24 jungle_log',
        '25 jungle_log',
        '26 jungle_log',
        '27 jungle_log',
        '28 jungle_log',
        '29 jungle_log',
        '30 jungle_log',
        '31 jungle_log',
        '32 jungle_log',
        '33 jungle_log',
        '34 jungle_log',
        '35 jungle_log',
        '0 netherite_helmet',
        '0 netherite_chestplate',
        '0 netherite_leggings',
        '0 netherite_boots',
        'NaN undefined',
        'NaN undefined',
        'NaN undefined',
        'NaN undefined',
        'NaN undefined',
        '0 shield',
      ]);
    });

    it('should move item to another empty slot', async () => {
      const dataBuilder = getDataBuilder('1.21.130');

      // Set up inventory with a sword in hotbar slot 0
      dataBuilder.setInventoryItem(0, 'netherite_sword', 1, 1001);

      const item_stack_requests = [];
      const interact_packets = [];
      const container_close_packets = [];

      registry.handleItemRegistry(dataBuilder.data.item_registry);
      server = await startServer('127.0.0.1', 25567, supportedVersion);
      setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
      client = await waitForClientConnect(server);

      // Capture interact packets (for opening inventory)
      client.on('interact', (packet) => {
        interact_packets.push(packet);

        // Send container_open in response to open_inventory action
        if (packet.action_id === 'open_inventory') {
          client.write('container_open', {
            window_id: 2,
            window_type: 'inventory',
            coordinates: { x: 0, y: 1, z: 0 },
            runtime_entity_id: '-1',
          });
          // Note: No inventory_content packet is sent here
          // The inventory is already populated from initializeClient
        }
      });

      // Capture item_stack_request packets
      client.on('item_stack_request', (packet) => {
        item_stack_requests.push(packet);
      });

      // Capture container_close packets
      client.on('container_close', (packet) => {
        container_close_packets.push(packet);

        // Send container_close confirmation
        client.write('container_close', {
          window_id: packet.window_id,
          window_type: 'none',
          server: true,
        });
      });

      await initializeClient(client, dataBuilder.data);

      // Wait a bit for initialization to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify initial state - sword should be in slot 0
      expect(bot.inventory.slots[0]?.name).toBe('netherite_sword');
      expect(bot.inventory.slots[0]?.count).toBe(1);
      expect(bot.inventory.slots[1]).toBeFalsy(); // null or undefined

      // Mock the server's response to item_stack_request
      let requestCount = 0;
      client.on('item_stack_request', (packet) => {
        // Send success response for each request
        for (const request of packet.requests) {
          requestCount++;
          const response = {
            responses: [
              {
                status: 'ok',
                request_id: request.request_id,
                containers: request.actions
                  .map((action) => {
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
                    }
                  })
                  .flat(),
              },
            ],
          };

          client.write('item_stack_response', response);
        }
      });

      // Move item from slot 0 to slot 1
      await bot.moveSlotItem(0, 1);

      // Verify the move operation - should be 1 request with 2 actions (take + place)
      expect(item_stack_requests.length).toBeGreaterThanOrEqual(1);

      // Request should contain both "take" and "place" actions
      const request = item_stack_requests[item_stack_requests.length - 1];
      expect(request.requests).toHaveLength(1);
      expect(request.requests[0].actions).toHaveLength(2);

      // First action should be a "take" from hotbar slot 0
      expect(request.requests[0].actions[0].type_id).toBe('take');
      expect(request.requests[0].actions[0].source.slot_type.container_id).toBe('hotbar');
      expect(request.requests[0].actions[0].source.slot).toBe(0);
      expect(request.requests[0].actions[0].destination.slot_type.container_id).toBe('cursor');

      // Second action should be a "place" to hotbar slot 1
      expect(request.requests[0].actions[1].type_id).toBe('place');
      expect(request.requests[0].actions[1].source.slot_type.container_id).toBe('cursor');
      expect(request.requests[0].actions[1].destination.slot_type.container_id).toBe('hotbar');
      expect(request.requests[0].actions[1].destination.slot).toBe(1);

      // Verify the interact packet was sent
      expect(interact_packets.length).toBeGreaterThanOrEqual(1);
      const lastInteract = interact_packets[interact_packets.length - 1];
      expect(lastInteract.action_id).toBe('open_inventory');

      // Verify the container was closed
      expect(container_close_packets.length).toBeGreaterThanOrEqual(1);
      const lastClose = container_close_packets[container_close_packets.length - 1];
      expect(lastClose.server).toBe(false);
    });

    afterEach(async () => {
      if (server) {
        await server.close();
        server = null;
      }
    });

    describe('digging', () => {
      it('should send start_break block_action when starting to dig', async () => {
        const dataBuilder = getDataBuilder('1.21.130');

        // Give bot a pickaxe to dig with
        dataBuilder.setInventoryItem(0, 'diamond_pickaxe', 1, 1001);

        const player_auth_input_packets: any[] = [];

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        // Capture player_auth_input packets with block_action
        client.on('player_auth_input', (packet: any) => {
          if (packet.block_action && packet.block_action.length > 0) {
            player_auth_input_packets.push({
              block_action: packet.block_action,
              input_data: {
                block_action: packet.input_data?.block_action,
              },
            });
          }
        });

        await initializeClient(client, dataBuilder.data);
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Disable physics to avoid block.shapes errors
        bot.physicsEnabled = false;

        // Create a mock block for testing with proper Vec3-like position
        const mockPosition = {
          x: 10,
          y: 64,
          z: 10,
          offset: (dx: number, dy: number, dz: number) => ({
            x: 10 + dx,
            y: 64 + dy,
            z: 10 + dz,
            minus: (other: any) => ({ x: 0, y: 0, z: 0 }),
            distanceTo: () => 2,
          }),
        };

        const mockBlock = {
          position: mockPosition,
          name: 'stone',
          diggable: true,
          digTime: () => 1000, // 1 second dig time
          type: 1,
          shapes: [[0, 0, 0, 1, 1, 1]],
        };

        // Start digging but cancel quickly to capture the start_break packet
        bot.dig(mockBlock as any, 'ignore').catch(() => {}); // Ignore cancel error

        // Wait for packets to be sent (physics runs every 50ms)
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Stop digging to cancel
        bot.stopDigging();

        // Wait a bit more for abort packet
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Verify start_break was sent
        expect(player_auth_input_packets.length).toBeGreaterThanOrEqual(1);

        const startBreakPacket = player_auth_input_packets.find((p) => p.block_action.some((a: any) => a.action === 'start_break'));
        expect(startBreakPacket).toBeDefined();

        const startAction = startBreakPacket.block_action.find((a: any) => a.action === 'start_break');
        expect(startAction.position.x).toBe(10);
        expect(startAction.position.y).toBe(64);
        expect(startAction.position.z).toBe(10);
      });

      it('should send abort_break when stopDigging is called', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'diamond_pickaxe', 1, 1001);

        const player_auth_input_packets: any[] = [];

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        client.on('player_auth_input', (packet: any) => {
          if (packet.block_action && packet.block_action.length > 0) {
            player_auth_input_packets.push({
              block_action: packet.block_action,
            });
          }
        });

        await initializeClient(client, dataBuilder.data);
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Disable physics
        bot.physicsEnabled = false;

        const mockPosition = {
          x: 10,
          y: 64,
          z: 10,
          offset: (dx: number, dy: number, dz: number) => ({
            x: 10 + dx,
            y: 64 + dy,
            z: 10 + dz,
            minus: () => ({ x: 0, y: 0, z: 0 }),
            distanceTo: () => 2,
          }),
        };

        const mockBlock = {
          position: mockPosition,
          name: 'stone',
          diggable: true,
          digTime: () => 5000, // 5 second dig time so we can cancel
          type: 1,
          shapes: [[0, 0, 0, 1, 1, 1]],
        };

        // Start digging
        bot.dig(mockBlock as any, 'ignore').catch(() => {}); // Ignore cancel error

        await new Promise((resolve) => setTimeout(resolve, 200));

        // Stop digging
        bot.stopDigging();

        await new Promise((resolve) => setTimeout(resolve, 200));

        // Find abort_break packet
        const abortPacket = player_auth_input_packets.find((p) => p.block_action.some((a: any) => a.action === 'abort_break'));

        expect(abortPacket).toBeDefined();
        const abortAction = abortPacket.block_action.find((a: any) => a.action === 'abort_break');
        expect(abortAction.position.x).toBe(10);
      });

      it('should send continue_break + predict_break when dig completes', async () => {
        const dataBuilder = getDataBuilder('1.21.130');
        dataBuilder.setInventoryItem(0, 'diamond_pickaxe', 1, 1001);

        const player_auth_input_packets: any[] = [];

        registry.handleItemRegistry(dataBuilder.data.item_registry);
        server = await startServer('127.0.0.1', 25567, supportedVersion);
        setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
        client = await waitForClientConnect(server);

        client.on('player_auth_input', (packet: any) => {
          if (packet.block_action && packet.block_action.length > 0) {
            player_auth_input_packets.push({
              block_action: packet.block_action,
              item_stack_request: packet.item_stack_request,
            });
          }
        });

        await initializeClient(client, dataBuilder.data);
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Disable physics
        bot.physicsEnabled = false;

        const mockPosition = {
          x: 10,
          y: 64,
          z: 10,
          offset: (dx: number, dy: number, dz: number) => ({
            x: 10 + dx,
            y: 64 + dy,
            z: 10 + dz,
            minus: () => ({ x: 0, y: 0, z: 0 }),
            distanceTo: () => 2,
          }),
        };

        const mockBlock = {
          position: mockPosition,
          name: 'dirt',
          diggable: true,
          digTime: () => 150, // Very short dig time
          type: 1,
          shapes: [[0, 0, 0, 1, 1, 1]],
        };

        // Mock _updateBlockState to prevent errors
        bot._updateBlockState = () => {};

        // Start digging and wait for completion
        bot.dig(mockBlock as any, 'ignore').catch(() => {});

        // Wait for dig to complete (150ms + buffer for physics ticks)
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Find predict_break packet (sent when dig completes)
        const predictPacket = player_auth_input_packets.find((p) => p.block_action.some((a: any) => a.action === 'predict_break'));

        expect(predictPacket).toBeDefined();

        // Should have both continue_break and predict_break in same packet
        const hasContBreak = predictPacket.block_action.some((a: any) => a.action === 'continue_break');
        const hasPredictBreak = predictPacket.block_action.some((a: any) => a.action === 'predict_break');

        expect(hasContBreak).toBe(true);
        expect(hasPredictBreak).toBe(true);
      });
    });
  });
}

// /* eslint-env mocha */
// const mineflayer = require('../')
// const assert = require('assert')
// const path = require('path')
// const { expect } = require('expect')

// // Test Bedrock Edition specific functionality
// describe('mineflayer_bedrock', function () {
//   this.timeout(10 * 1000 * 1000)

//   describe('inventory', () => {
//     // Test that the bot sends the correct mob_equipment packets after receiving play_status
//     // This validates inventory.mts:120-148 which sends equipment updates on spawn
//     it('sends correct mob_equipment packets after play_status', (done) => {
//       // Path to the binary packet dump file
//       const packetDumpPath = path.join(__dirname, '../../mineflayer-bedrock/dumps/1.21.130-1766996035755 - activate hotbar slot.bin')

//       // Track mob_equipment packets sent by the bot
//       const mobEquipmentPackets = []
//       let expectedPackets = 2 // We expect 2 mob_equipment packets

//       // Create bot with replay client
//       const { createReplayClient } = require('../../mineflayer-bedrock/src/bedrock-replay-protocol/index.ts')
//       const replayClient = createReplayClient(packetDumpPath, true)

//       // Intercept write calls to capture mob_equipment packets
//       const originalWrite = replayClient.write.bind(replayClient)
//       replayClient.write = (packetName, data) => {
//         if (packetName === 'mob_equipment') {
//           mobEquipmentPackets.push(data)

//           // Check if we've received all expected packets
//           if (mobEquipmentPackets.length === expectedPackets) {
//             // Wait a tick to ensure no more packets are sent
//             setImmediate(() => {
//               try {
//                 // Verify we have exactly 2 mob_equipment packets
//                 assert.strictEqual(mobEquipmentPackets.length, 2, 'Should send exactly 2 mob_equipment packets')

//                 // First packet: inventory slot with iron sword (network_id 261)
//                 const firstPacket = mobEquipmentPackets[0]
//                 // assert.strictEqual(firstPacket.window_id, 'inventory', 'First packet should be for inventory window')
//                 // assert.strictEqual(firstPacket.item.network_id, 261, 'First packet should have iron sword (network_id 261)')
//                 // assert.strictEqual(firstPacket.slot, 5, 'First packet should be for prismarine slot 14 (hotbar slot 5)')
//                 // assert.strictEqual(firstPacket.selected_slot, 5, 'First packet selected_slot should be 14')

//                 // Second packet: offhand slot with shield (network_id 387)
//                 const secondPacket = mobEquipmentPackets[1]
//                 // assert.strictEqual(secondPacket.window_id, 'offhand', 'Second packet should be for offhand window')
//                 // assert.strictEqual(secondPacket.item.network_id, 387, 'Second packet should have shield (network_id 387)')
//                 // assert.strictEqual(secondPacket.slot, 1, 'Second packet should be for offhand slot 1')
//                 // assert.strictEqual(secondPacket.selected_slot, 0, 'Second packet selected_slot should be 0')

//                 expect(firstPacket).toEqual({
//                   "runtime_entity_id": 182n,
//                   "item": {
//                     "network_id": 261,
//                     "count": 1,
//                     "metadata": 0,
//                     "has_stack_id": 0,
//                     "block_runtime_id": 0,
//                     "extra": {
//                       "has_nbt": true,
//                       "nbt": {
//                         "version": 1,
//                         "nbt": {
//                           "type": "compound",
//                           "name": "",
//                           "value": {
//                             "Damage": {
//                               "type": "int",
//                               "value": 0
//                             }
//                           }
//                         }
//                       },
//                       "can_place_on": [],
//                       "can_destroy": []
//                     }
//                   },
//                   "slot": 5,
//                   "selected_slot": 5,
//                   "window_id": "inventory"
//                 })

//                 expect(secondPacket).toEqual({
//                   "runtime_entity_id": 182n,
//                   "item": {
//                     "network_id": 387,
//                     "count": 1,
//                     "metadata": 0,
//                     "has_stack_id": 0,
//                     "block_runtime_id": 0,
//                     "extra": {
//                       "has_nbt": true,
//                       "nbt": {
//                         "version": 1,
//                         "nbt": {
//                           "type": "compound",
//                           "name": "",
//                           "value": {
//                             "Damage": {
//                               "type": "int",
//                               "value": 0
//                             }
//                           }
//                         }
//                       },
//                       "can_place_on": [],
//                       "can_destroy": [],
//                       "blocking_tick": 0n
//                     }
//                   },
//                   "slot": 1,
//                   "selected_slot": 0,
//                   "window_id": "offhand"
//                 })

//                 done()
//               } catch (err) {
//                 done(err)
//               }
//             })
//           }
//         }
//         return originalWrite(packetName, data)
//       }

//       const bot = mineflayer.createBot({
//         host: '127.0.0.1',
//         port: 19132,
//         username: 'TestBot',
//         version: 'bedrock_1.21.130',
//         client: replayClient
//       })

//       bot.once('error', (err) => {
//         done(err)
//       })

//       // If no mob_equipment packets are sent within timeout, fail the test
//       setTimeout(() => {
//         if (mobEquipmentPackets.length < expectedPackets) {
//           done(new Error(`Expected ${expectedPackets} mob_equipment packets but only received ${mobEquipmentPackets.length}`))
//         }
//       }, 5000)
//     })
//   })
// })
