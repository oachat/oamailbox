/**
 * Cloudflare KV storage helpers.
 * All KV operations are guarded with optional-chaining so the bot
 * degrades gracefully if KV is not bound.
 */

// --- Key builders ---

const userKey = (userId) => `user:${userId}`;
const configKey = (ownerUid) => `config:${ownerUid}`;
const promptKey = (userId) => `prompt:${userId}`;
const verifyPendingKey = (userId) => `pending:${userId}`;
const topicFromChatKey = (fromChatId) => `topic:from:${fromChatId}`;
const topicByIdKey = (topicId) => `topic:id:${topicId}`;
const msgTopicKey = (topicId, topicMsgId) => `msg:topic:${topicId}:${topicMsgId}`;
const msgPmKey = (pmChatId, pmMsgId) => `msg:pm:${pmChatId}:${pmMsgId}`;

// --- User ---

export async function getUser(env, userId) {
  return (await env.KV?.get(userKey(userId), 'json')) || null;
}

export async function saveUser(env, user) {
  if (!env?.KV) return;
  await env.KV.put(userKey(user.id), JSON.stringify(user));
}

// --- Config ---

export async function saveConfig(env, ownerUid, config) {
  if (!env?.KV) return;
  await env.KV.put(configKey(ownerUid), JSON.stringify(config));
}

export async function getConfig(env, ownerUid) {
  if (!env?.KV) return null;
  return (await env.KV.get(configKey(ownerUid), 'json')) || null;
}

export async function deleteConfig(env, ownerUid) {
  if (!env?.KV) return;
  await env.KV.delete(configKey(ownerUid));
}

// --- Verify prompts ---

export async function saveVerifyPrompt(env, userId, messageId) {
  if (!env?.KV) return;
  const list = await getAllVerifyPrompts(env, userId);
  list.push(messageId);
  await env.KV.put(promptKey(userId), JSON.stringify(list));
}

export async function getAllVerifyPrompts(env, userId) {
  const raw = await env.KV?.get(promptKey(userId), 'json');
  return Array.isArray(raw) ? raw : [];
}

export async function deleteVerifyPrompt(env, userId) {
  if (!env?.KV) return;
  await env.KV.delete(promptKey(userId));
}

// --- Verify pending marker (KV lag detection) ---

export async function getVerifyPending(env, userId) {
  return await env.KV?.get(verifyPendingKey(userId));
}

export async function setVerifyPending(env, userId, value = '1') {
  if (!env?.KV) return;
  await env.KV.put(verifyPendingKey(userId), value);
}

// --- Topic mapping ---

export async function getTopicByFromChat(env, fromChatId) {
  return await env.KV?.get(topicFromChatKey(fromChatId), 'json');
}

export async function getTopicById(env, topicId) {
  return await env.KV?.get(topicByIdKey(topicId), 'json');
}

export async function saveTopicMapping(env, data) {
  if (!env?.KV) return;
  const payload = { ...data, banned: !!data.banned };
  await env.KV.put(topicFromChatKey(data.fromChatId), JSON.stringify(payload));
  await env.KV.put(topicByIdKey(data.topicId), JSON.stringify(payload));
}

export async function setTopicBanned(env, topicId, banned) {
  const topic = await getTopicById(env, topicId);
  if (!topic) return null;
  topic.banned = banned;
  await saveTopicMapping(env, topic);
  return topic;
}

// --- Message mapping ---

export async function saveMessageConnection(env, connection) {
  if (!env?.KV) return;
  await env.KV.put(msgTopicKey(connection.topicId, connection.topicMsgId), JSON.stringify(connection));
  await env.KV.put(msgPmKey(connection.pmChatId, connection.pmMsgId), JSON.stringify(connection));
}

export async function getConnectionByTopic(env, topicId, topicMsgId) {
  return await env.KV?.get(msgTopicKey(topicId, topicMsgId), 'json');
}

export async function getConnectionByPm(env, pmChatId, pmMsgId) {
  return await env.KV?.get(msgPmKey(pmChatId, pmMsgId), 'json');
}

// --- Bulk cleanup (with pagination) ---

export async function clearAllMappings(env) {
  if (!env?.KV) return;
  const prefixes = ['topic:from:', 'topic:id:', 'msg:topic:', 'msg:pm:'];
  for (const prefix of prefixes) {
    let cursor = undefined;
    do {
      const list = await env.KV.list({ prefix, cursor });
      for (const key of list.keys) {
        await env.KV.delete(key.name);
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
  }
}
