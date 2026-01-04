import type { Bot } from '../..'
import { createDoneTask, createTask } from '../promise_utils.js'

export default function inject(bot: Bot) {
  let fishingTask = createDoneTask()
  let lastBobber: any = null

  // In Bedrock, the fishing bobber is called "minecraft:fishing_hook"
  const FISHING_HOOK_TYPE = 'minecraft:fishing_hook'

  // Handle fishing hook entity spawn
  bot._client.on('add_entity', (packet: {
    entity_type: string
    runtime_id: number | bigint
    unique_id?: number | bigint
  }) => {
    if (packet.entity_type === FISHING_HOOK_TYPE && !fishingTask.done && !lastBobber) {
      // Store the bobber entity reference
      const entityId = typeof packet.runtime_id === 'bigint'
        ? Number(packet.runtime_id)
        : packet.runtime_id
      lastBobber = bot.entities[entityId]

      // If entity isn't immediately available, wait for it
      if (!lastBobber) {
        // Store the ID to track it later
        lastBobber = { id: entityId, _pending: true }
      }
    }
  })

  // Handle entity events for fishing hook
  // In Bedrock, fish_hook_hook event indicates a fish is hooked
  bot._client.on('entity_event', (packet: {
    runtime_entity_id: number | bigint
    event_id: string
  }) => {
    if (!lastBobber || fishingTask.done) return

    // When fish_hook_hook event fires, a fish is on the hook!
    if (packet.event_id === 'fish_hook_hook') {
      const entityId = typeof packet.runtime_entity_id === 'bigint'
        ? Number(packet.runtime_entity_id)
        : packet.runtime_entity_id

      const bobberId = lastBobber._pending ? lastBobber.id : lastBobber.id
      if (entityId === bobberId) {
        // Reel in the fish!
        bot.activateItem()
        lastBobber = null
        fishingTask.finish()
      }
    }
  })

  // Handle bobber entity removal
  bot._client.on('remove_entity', (packet: {
    entity_id_self: number | bigint
  }) => {
    if (!lastBobber) return

    const removedId = typeof packet.entity_id_self === 'bigint'
      ? Number(packet.entity_id_self)
      : packet.entity_id_self

    const bobberId = lastBobber._pending ? lastBobber.id : lastBobber.id
    if (removedId === bobberId) {
      lastBobber = null
      if (!fishingTask.done) {
        fishingTask.cancel(new Error('Fishing cancelled'))
      }
    }
  })

  async function fish(): Promise<void> {
    if (!fishingTask.done) {
      fishingTask.cancel(new Error('Fishing cancelled due to calling bot.fish() again'))
    }

    fishingTask = createTask()
    lastBobber = null

    // Cast the fishing rod
    bot.activateItem()

    // Wait for fish to bite
    await fishingTask.promise
  }

  bot.fish = fish
}
