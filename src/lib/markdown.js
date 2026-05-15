/**
 * Telegram MarkdownV2 escaping utility.
 * Covers all special characters per Bot API docs.
 */

export function escapeMd(text) {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
