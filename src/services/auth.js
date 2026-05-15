/**
 * Verification gate — decides whether a user may send messages.
 * Handles KV eventual-consistency via a verify_pending marker.
 */

import { postToTelegramApi, chinaTime } from '../lib/telegram.js';
import {
  getUser,
  saveUser,
  saveVerifyPrompt,
  deleteVerifyPrompt,
  getAllVerifyPrompts,
  getVerifyPending,
  setVerifyPending,
} from '../lib/kv.js';

// --- Public API ---

export function isVerifyEnabled(env, miniAppUrl) {
  return !!(env?.KV && env?.TURNSTILE_SECRET && miniAppUrl);
}

/**
 * Returns true if the user is allowed to proceed, false if blocked (prompt sent).
 */
export async function ensureUserVerified(
  env, botToken, ownerUid, miniAppUrl,
  fromUser, fromChat, message,
  workerOrigin, prefix,
) {
  if (!isVerifyEnabled(env, miniAppUrl)) return true;
  if (fromUser.id.toString() === ownerUid) return true;
  if (fromChat.is_forum) return true;
  if (message?.text === '/start') return true;

  const user = await getUser(env, fromUser.id);
  if (user?.verified) return true;

  // KV eventual consistency workaround:
  // After handleVerifyApi saves verified=true, a webhook on a different edge
  // may still read stale data (user=null). verify_pending='done' is a durable
  // signal that verification completed — trust it even if user record hasn't
  // propagated yet.
  if (!user) {
    const pending = await getVerifyPending(env, fromUser.id);
    if (pending === 'done') {
      await saveUser(env, { id: fromUser.id, verified: true, verifiedAt: chinaTime() });
      return true;
    }
  }

  await setVerifyPending(env, fromUser.id);
  await sendVerifyPrompt(env, botToken, ownerUid, miniAppUrl, fromUser, fromChat, workerOrigin, prefix);
  return false;
}

/**
 * Sends a new verification prompt button, cleaning up any previous ones first.
 */
export async function sendVerifyPrompt(
  env, botToken, ownerUid, miniAppUrl,
  fromUser, fromChat,
  workerOrigin, prefix,
) {
  await clearVerifyPrompts(env, botToken, fromChat.id, fromUser.id);

  const verifyUrl = new URL(miniAppUrl);
  if (workerOrigin) verifyUrl.searchParams.set('api_base', workerOrigin);
  if (prefix) verifyUrl.searchParams.set('prefix', prefix);

  const keyboard = {
    inline_keyboard: [[{
      text: '点击验证 ✅',
      web_app: { url: verifyUrl.toString() },
    }]],
  };

  const resp = await postToTelegramApi(botToken, 'sendMessage', {
    chat_id: fromChat.id,
    text: '为了防止滥用，请先完成验证\n点击下方按钮完成验证后即可给oa发送消息',
    reply_markup: keyboard,
  });

  try {
    const data = await resp.json();
    if (data.ok && data.result?.message_id) {
      await saveVerifyPrompt(env, fromUser.id, data.result.message_id);
    }
  } catch (_) {
    // best-effort
  }
}

// --- Internal ---

async function clearVerifyPrompts(env, botToken, chatId, userId) {
  const promptList = await getAllVerifyPrompts(env, userId);
  for (const mid of promptList) {
    await postToTelegramApi(botToken, 'deleteMessage', {
      chat_id: chatId,
      message_id: mid,
    });
  }
  await deleteVerifyPrompt(env, userId);
}
