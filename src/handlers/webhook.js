/**
 * Telegram webhook update handler.
 * Dispatches incoming updates to the appropriate service or command handler.
 */

import { postToTelegramApi } from '../lib/telegram.js';
import { timingSafeEqual } from '../lib/crypto.js';
import { getConfig, getTopicById } from '../lib/kv.js';
import { ensureUserVerified } from '../services/auth.js';
import {
  processERReceived,
  processERSent,
  processPMEditReceived,
  processPMEditSent,
  processPMReceived,
  processPMSent,
  processPMDeleteReceived,
  processPMDeleteSent,
} from '../services/topic.js';

import {
  handleStartCommand,
  handleForumAdminCommands,
  handleOwnerChatCommands,
} from './commands.js';

const ADMIN_COMMANDS = new Set(['.init', '.check', '.reset', '.ban', '.unban', '.sban', '.sunban']);

export async function handleWebhook(request, env, config) {
  const { botToken, ownerUid, secretToken, miniAppUrl, prefix } = config;

  // Timing-safe secret token verification
  const headerToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!await timingSafeEqual(secretToken, headerToken)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const update = await request.json();

  // ─── Edited message ────────────────────────────────────────────
  if (update.edited_message) {
    const messageEdited = update.edited_message;
    const fromChat = messageEdited.chat;
    const fromUser = messageEdited.from;

    if (fromChat.is_forum && fromUser.id.toString() === ownerUid) {
      await processPMEditSent(botToken, env, messageEdited);
    } else if (!fromChat.is_forum) {
      await processPMEditReceived(botToken, env, ownerUid, messageEdited);
    }
    return new Response('OK');
  }

  // ─── Emoji reactions ───────────────────────────────────────────
  if (update.message_reaction) {
    const messageReaction = update.message_reaction;
    const fromUser = messageReaction.user || messageReaction.actor_chat;
    if (!fromUser) return new Response('OK');

    if (messageReaction.chat.is_forum) {
      await processERSent(botToken, env, messageReaction);
    } else {
      await processERReceived(botToken, env, ownerUid, fromUser, messageReaction);
    }
    return new Response('OK');
  }

  // ─── Messages ──────────────────────────────────────────────────
  if (!update.message) {
    return new Response('OK');
  }

  const message = update.message;
  const fromChat = message.chat;
  const fromUser = message.from;
  const kvConfig = await getConfig(env, ownerUid);
  const workerOrigin = new URL(request.url).origin;

  // Verification gate for non-owner direct chats
  const isVerified = await ensureUserVerified(
    env, botToken, ownerUid, miniAppUrl,
    fromUser, fromChat, message,
    workerOrigin, prefix,
  );
  if (!isVerified) {
    return new Response('OK');
  }

  try {
    // ── Admin commands ───────────────────────────────────────────
    if (
      fromUser.id.toString() === ownerUid &&
      fromChat.is_forum &&
      ADMIN_COMMANDS.has(message.text)
    ) {
      return await handleForumAdminCommands(botToken, ownerUid, env, message, kvConfig);
    }

    // ── Owner chat admin commands ─────────────────────────────────
    if (
      fromUser.id.toString() === ownerUid &&
      !fromChat.is_forum &&
      ADMIN_COMMANDS.has(message.text)
    ) {
      return await handleOwnerChatCommands(botToken, ownerUid, env, message);
    }

    // ── Delete command (#del by reply) ────────────────────────────
    const reply = message.reply_to_message;
    if (reply && message.text?.toLowerCase() === '#del') {
      if (fromChat.is_forum && fromUser.id.toString() === ownerUid) {
        await processPMDeleteSent(botToken, env, message, reply);
      } else if (!fromChat.is_forum) {
        await processPMDeleteReceived(botToken, env, ownerUid, message, reply);
      }
      return new Response('OK');
    }

    // ── Skip system messages ──────────────────────────────────────
    if (message.forum_topic_created || message.pinned_message) {
      return new Response('OK');
    }

    // ── /start command ────────────────────────────────────────────
    if (message.text === '/start') {
      return await handleStartCommand(
        botToken, ownerUid, env, miniAppUrl,
        fromUser, fromChat, message,
        workerOrigin, prefix,
      );
    }

    // ── owner → user (forum topic reply) ──────────────────────────
    if (fromChat.is_forum && kvConfig?.superGroupChatId) {
      const topicId = message.message_thread_id;
      const topic = await getTopicById(env, topicId);
      if (topic) {
        if (fromUser.id.toString() === ownerUid) {
          await processPMSent(botToken, env, message, topic);
        } else {
          await postToTelegramApi(botToken, 'forwardMessage', {
            chat_id: kvConfig.superGroupChatId,
            message_thread_id: topicId,
            from_chat_id: fromChat.id,
            message_id: message.message_id,
          });
        }
      }
      return new Response('OK');
    }

    // ── user → owner (private message) ────────────────────────────
    if (!fromChat.is_forum && kvConfig?.superGroupChatId) {
      const result = await processPMReceived(botToken, ownerUid, env, message, kvConfig);
      if (!result?.success) {
        console.error(JSON.stringify({
          message: 'processPMReceived failed',
          fromChatId: fromChat.id,
          messageId: message.message_id,
        }));
      }
      return new Response('OK');
    }

    return new Response('OK');
  } catch (error) {
    console.error(JSON.stringify({ message: 'webhook handler error', error: error?.message, stack: error?.stack }));
    return new Response('OK');
  }
}
