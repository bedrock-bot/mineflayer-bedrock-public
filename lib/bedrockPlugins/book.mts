/**
 * Bedrock Edition book plugin
 *
 * Provides book writing and signing functionality for Bedrock.
 *
 * Protocol differences from Java:
 * - Java: Uses `edit_book` packet with NBT data
 * - Bedrock: Uses `book_edit` packet with action-based editing
 *   - action: "replace_page" - Update page content
 *   - action: "add_page" - Add new page (not commonly used, replace_page auto-creates)
 *   - action: "delete_page" - Remove a page
 *   - action: "swap_pages" - Swap two pages
 *   - action: "sign" - Sign and finalize book (becomes written_book)
 *
 * Book editing flow:
 *   1. Hold writable_book (book and quill)
 *   2. Right-click to open (inventory_transaction item_use click_air)
 *   3. C→S: book_edit {action: "replace_page", slot, page, text}
 *   4. C→S: book_edit {action: "sign", slot, title, author, xuid}
 *   5. Book becomes written_book (no server confirmation packet)
 *
 * API (matches Java):
 *   - bot.writeBook(slot, pages) - Write pages to book and quill
 *   - bot.signBook(slot, pages, author, title) - Write and sign book
 */

import type { Bot } from '../..'
import * as assert from 'assert'

export default function inject(bot: Bot) {
  /**
   * Send a book_edit packet to write page content
   */
  function sendBookEdit(
    slot: number,
    action: string,
    options: {
      page?: number;
      text?: string;
      secondaryPage?: number;
      title?: string;
      author?: string;
    } = {},
  ) {
    const packet: Record<string, unknown> = {
      type: action, // Bedrock uses 'type' field for action
      slot,
      page_number: options.page ?? 0,
      secondary_page_number: options.secondaryPage ?? 0,
      text: options.text ?? '',
      photo_name: '',
      title: options.title ?? '',
      author: options.author ?? '',
      xuid: '', // XUID is handled by server based on client
    };

    bot._client.write('book_edit', packet);
  }

  /**
   * Write content to a book and quill without signing
   *
   * @param slot - Inventory slot containing the book (0-44)
   * @param pages - Array of page contents (strings)
   */
  async function writeBook(slot: number, pages: string[]): Promise<void> {
    assert.ok(slot >= 0 && slot <= 44, 'slot out of inventory range');

    const book = bot.inventory.slots[slot];
    const writableBookId = bot.registry.itemsByName.writable_book?.id;

    assert.ok(book && writableBookId && book.type === writableBookId, `no book found in slot ${slot}`);

    const quickBarSlot = bot.quickBarSlot;
    const moveToQuickBar = slot < 36;

    // Move book to hotbar if needed
    if (moveToQuickBar) {
      await bot.moveSlotItem(slot, 36);
    }

    // Select the book slot
    bot.setQuickBarSlot(moveToQuickBar ? 0 : slot - 36);

    // Write each page
    const hotbarSlot = moveToQuickBar ? 0 : slot - 36;
    for (let i = 0; i < pages.length; i++) {
      sendBookEdit(hotbarSlot, 'replace_page', {
        page: i,
        text: pages[i],
      });
    }

    // Small delay to let server process
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Restore original quickbar slot
    bot.setQuickBarSlot(quickBarSlot);

    // Move book back if we moved it
    if (moveToQuickBar) {
      await bot.moveSlotItem(36, slot);
    }
  }

  /**
   * Write content to a book and sign it
   *
   * @param slot - Inventory slot containing the book (0-44)
   * @param pages - Array of page contents (strings)
   * @param author - Author name for the signed book
   * @param title - Title for the signed book
   */
  async function signBook(slot: number, pages: string[], author: string, title: string): Promise<void> {
    assert.ok(slot >= 0 && slot <= 44, 'slot out of inventory range');

    const book = bot.inventory.slots[slot];
    const writableBookId = bot.registry.itemsByName.writable_book?.id;

    assert.ok(book && writableBookId && book.type === writableBookId, `no book found in slot ${slot}`);

    const quickBarSlot = bot.quickBarSlot;
    const moveToQuickBar = slot < 36;

    // Move book to hotbar if needed
    if (moveToQuickBar) {
      await bot.moveSlotItem(slot, 36);
    }

    // Select the book slot
    bot.setQuickBarSlot(moveToQuickBar ? 0 : slot - 36);

    // Write each page first
    const hotbarSlot = moveToQuickBar ? 0 : slot - 36;
    for (let i = 0; i < pages.length; i++) {
      sendBookEdit(hotbarSlot, 'replace_page', {
        page: i,
        text: pages[i],
      });
    }

    // Small delay before signing
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Sign the book
    sendBookEdit(hotbarSlot, 'sign', {
      title,
      author,
    });

    // Wait for inventory update (book becomes written_book)
    const inventorySlot = moveToQuickBar ? 36 : slot;
    await new Promise<void>((resolve) => {
      const handler = (oldItem: unknown, newItem: unknown) => {
        // Book was signed when it changes type
        const newItemTyped = newItem as { type?: number } | null;
        const writtenBookId = bot.registry.itemsByName.written_book?.id;
        if (newItemTyped && writtenBookId && newItemTyped.type === writtenBookId) {
          bot.inventory.off(`updateSlot:${inventorySlot}`, handler);
          resolve();
        }
      };
      bot.inventory.on(`updateSlot:${inventorySlot}`, handler);

      // Timeout after 5 seconds
      setTimeout(() => {
        bot.inventory.off(`updateSlot:${inventorySlot}`, handler);
        resolve(); // Resolve anyway, server might not send update
      }, 5000);
    });

    // Restore original quickbar slot
    bot.setQuickBarSlot(quickBarSlot);

    // Move book back if we moved it
    if (moveToQuickBar) {
      await bot.moveSlotItem(36, slot);
    }
  }

  // Expose API on bot object
  bot.writeBook = writeBook;
  bot.signBook = signBook;
}
