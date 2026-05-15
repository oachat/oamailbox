/**
 * Topic-based private message forwarding service.
 * Handles: receive, send, edit, delete, emoji reactions, ban/unban.
 */

import { postToTelegramApi, chinaTime } from '../lib/telegram.js';
import { escapeMd } from '../lib/markdown.js';
import {
  getConnectionByPm,
  getConnectionByTopic,
  getTopicByFromChat,
  saveMessageConnection,
  saveTopicMapping,
  setTopicBanned,
  getConfig,
  saveConfig,
  deleteConfig,
  clearAllMappings,
} from '../lib/kv.js';

// ─── Settings ────────────────────────────────────────────────────────

export async function init(botToken, ownerUid, env, message) {
  try {
    const supergroupId = message.chat.id;
    if (!message.chat.is_forum) {
      await postToTelegramApi(botToken, 'sendMessage', {
        chat_id: ownerUid,
        text: '请在启用话题的群组中初始化。',
      });
      return new Response('OK');
    }

    await saveConfig(env, ownerUid, { superGroupChatId: supergroupId });
    await postToTelegramApi(botToken, 'sendMessage', {
      chat_id: ownerUid,
      text: `群组 ${supergroupId}: 初始化成功!`,
    });
    return new Response('OK');
  } catch (error) {
    console.error(JSON.stringify({ message: 'init error', error: error.message }));
    return new Response('OK');
  }
}

export async function checkInit(botToken, ownerUid, env, message) {
  try {
    const supergroupId = message.chat.id;
    const config = await getConfig(env, ownerUid);
    if (!config?.superGroupChatId) {
      await postToTelegramApi(botToken, 'sendMessage', {
        chat_id: ownerUid,
        text: `群组 ${supergroupId}: 未初始化`,
      });
      return new Response('OK');
    }
    const text =
      config.superGroupChatId !== supergroupId
        ? `群组 ${supergroupId}: 初始化失败! 已绑定群组 ${config.superGroupChatId}`
        : `群组 ${supergroupId}: 初始化正常`;
    await postToTelegramApi(botToken, 'sendMessage', { chat_id: ownerUid, text });
    return new Response('OK');
  } catch (error) {
    console.error(JSON.stringify({ message: 'checkInit error', error: error.message }));
    return new Response('OK');
  }
}

export async function reset(botToken, ownerUid, env, message, inOwnerChat) {
  try {
    const supergroupId = message.chat.id;
    const config = await getConfig(env, ownerUid);
    if (!config?.superGroupChatId) {
      await postToTelegramApi(botToken, 'sendMessage', {
        chat_id: ownerUid,
        text: '尚未初始化!',
      });
      return new Response('OK');
    }
    if (!inOwnerChat && config.superGroupChatId !== supergroupId) {
      await postToTelegramApi(botToken, 'sendMessage', {
        chat_id: ownerUid,
        text: '无法重置，该群组当前未在使用中!',
      });
      return new Response('OK');
    }

    await deleteConfig(env, ownerUid);
    await clearAllMappings(env);

    await postToTelegramApi(botToken, 'sendMessage', {
      chat_id: ownerUid,
      text: '重置成功!',
    });
    return new Response('OK');
  } catch (error) {
    console.error(JSON.stringify({ message: 'reset error', error: error.message }));
    return new Response('OK');
  }
}

// ─── Private Message ─────────────────────────────────────────────────

export async function processPMReceived(botToken, ownerUid, env, message, config) {
  const fromChat = message.chat;
  const fromChatId = fromChat.id;
  const pmMessageId = message.message_id;
  const superGroupChatId = config.superGroupChatId;

  // Topic mapping — create new topic if none exists
  let topic = await getTopicByFromChat(env, fromChatId);
  if (!topic) {
    const createTopicResp = await (
      await postToTelegramApi(botToken, 'createForumTopic', {
        chat_id: superGroupChatId,
        name: buildTopicName(fromChat),
      })
    ).json();

    const topicId = createTopicResp.result?.message_thread_id;
    if (!createTopicResp.ok || !topicId) {
      await postToTelegramApi(botToken, 'sendMessage', {
        chat_id: ownerUid,
        text: `创建话题失败: ${JSON.stringify(createTopicResp)}`,
      });
      return { success: false };
    }

    topic = { topicId, fromChatId, superGroupChatId, banned: false };
    await saveTopicMapping(env, topic);

    // Send and pin user info card in new topic
    await sendTopicUserInfo(botToken, superGroupChatId, topic.topicId, fromChat, fromChatId);
  }

  if (topic.banned) return { success: false };

  // Check if user replied to a specific message — resolve the corresponding topic message
  let topicReplyMsgId = null;
  const replyToMsg = message.reply_to_message;
  if (replyToMsg) {
    const replyConn = await getConnectionByPm(env, fromChatId, replyToMsg.message_id);
    if (replyConn) topicReplyMsgId = replyConn.topicMsgId;
  }

  // Forward PM to topic (use copyMessage if we need reply_parameters, forwardMessage otherwise)
  let forwardResp;
  if (topicReplyMsgId) {
    forwardResp = await (
      await postToTelegramApi(botToken, 'copyMessage', {
        chat_id: superGroupChatId,
        message_thread_id: topic.topicId,
        from_chat_id: fromChatId,
        message_id: pmMessageId,
        reply_parameters: { message_id: topicReplyMsgId },
      })
    ).json();
  } else {
    forwardResp = await (
      await postToTelegramApi(botToken, 'forwardMessage', {
        chat_id: superGroupChatId,
        message_thread_id: topic.topicId,
        from_chat_id: fromChatId,
        message_id: pmMessageId,
      })
    ).json();
  }
  if (!forwardResp.ok) return { success: false };

  await saveMessageConnection(env, {
    topicId: topic.topicId,
    topicMsgId: forwardResp.result.message_id,
    pmChatId: fromChatId,
    pmMsgId: pmMessageId,
    superGroupChatId,
    fromChatId,
  });

  // ack with 🕊
  await postToTelegramApi(botToken, 'setMessageReaction', {
    chat_id: fromChatId,
    message_id: pmMessageId,
    reaction: [{ type: 'emoji', emoji: '🕊' }],
  });

  return { success: true };
}

export async function processPMSent(botToken, env, message, topic) {
  if (!topic) return;
  const topicId = message.message_thread_id;
  const superGroupChatId = message.chat.id;
  const topicMessageId = message.message_id;
  const pmChatId = topic.fromChatId;

  // If owner replied to a specific message in the topic, resolve the corresponding PM message
  const copyParams = {
    chat_id: pmChatId,
    from_chat_id: superGroupChatId,
    message_id: topicMessageId,
  };
  const replyToMsg = message.reply_to_message;
  if (replyToMsg && replyToMsg.message_id !== topicId) {
    const replyConn = await getConnectionByTopic(env, topicId, replyToMsg.message_id);
    if (replyConn) {
      copyParams.reply_parameters = { message_id: replyConn.pmMsgId };
    }
  }

  const copyResp = await (
    await postToTelegramApi(botToken, 'copyMessage', copyParams)
  ).json();
  if (!copyResp.ok) return;

  await saveMessageConnection(env, {
    topicId,
    topicMsgId: topicMessageId,
    pmChatId,
    pmMsgId: copyResp.result.message_id,
    superGroupChatId,
    fromChatId: pmChatId,
  });

  await postToTelegramApi(botToken, 'setMessageReaction', {
    chat_id: superGroupChatId,
    message_id: topicMessageId,
    reaction: [{ type: 'emoji', emoji: '🕊' }],
  });
}

// ─── Emoji Reactions ─────────────────────────────────────────────────

export async function processERReceived(botToken, env, ownerUid, fromUser, messageReaction) {
  const connection = await getConnectionByPm(env, messageReaction.chat.id, messageReaction.message_id);
  if (!connection) return;

  // Owner clearing reaction → restore to 🕊
  if (messageReaction.new_reaction.length === 0 && fromUser.id.toString() === ownerUid) {
    messageReaction.new_reaction = [{ type: 'emoji', emoji: '🕊' }];
  }

  await postToTelegramApi(botToken, 'setMessageReaction', {
    chat_id: connection.superGroupChatId,
    message_id: connection.topicMsgId,
    reaction: messageReaction.new_reaction,
  });
}

export async function processERSent(botToken, env, messageReaction) {
  const connection = await getConnectionByTopic(
    env,
    messageReaction.message_thread_id,
    messageReaction.message_id,
  );
  if (!connection) return;

  let reaction = messageReaction.new_reaction;
  if (reaction.length === 0) {
    reaction = [{ type: 'emoji', emoji: '🕊' }];
  }

  await postToTelegramApi(botToken, 'setMessageReaction', {
    chat_id: connection.pmChatId,
    message_id: connection.pmMsgId,
    reaction,
  });
}

// ─── Edit Message ────────────────────────────────────────────────────

export async function processPMEditReceived(botToken, env, ownerUid, message) {
  const connection = await getConnectionByPm(env, message.chat.id, message.message_id);
  if (!connection) return;

  const forwardResp = await (
    await postToTelegramApi(botToken, 'copyMessage', {
      chat_id: connection.superGroupChatId,
      message_thread_id: connection.topicId,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
    })
  ).json();

  if (forwardResp.ok) {
    await saveMessageConnection(env, {
      topicId: connection.topicId,
      topicMsgId: forwardResp.result.message_id,
      pmChatId: connection.pmChatId,
      pmMsgId: connection.pmMsgId,
      superGroupChatId: connection.superGroupChatId,
      fromChatId: connection.fromChatId,
    });

    let oldMessageLink = '';
    if (connection.superGroupChatId.toString().startsWith('-100')) {
      const chatNum = connection.superGroupChatId.toString().substring(4);
      oldMessageLink = `https://t.me/c/${chatNum}/${connection.topicId}/${connection.topicMsgId}`;
    }

    await postToTelegramApi(botToken, 'sendMessage', {
      chat_id: connection.superGroupChatId,
      message_thread_id: connection.topicId,
      text: oldMessageLink
        ? `👆\n*此条消息已编辑* 查看[原始消息](${oldMessageLink})`
        : '👆\n*此条消息已编辑*',
      parse_mode: 'MarkdownV2',
    });

    await notifyMessageEditForward(botToken, message.chat.id, message.message_id);
  }
}

export async function processPMEditSent(botToken, env, message) {
  const connection = await getConnectionByTopic(env, message.message_thread_id, message.message_id);
  if (!connection) return;

  const resp = await postToTelegramApi(botToken, 'editMessageText', {
    chat_id: connection.pmChatId,
    message_id: connection.pmMsgId,
    text: message.text,
    parse_mode: message.parse_mode,
    entities: message.entities,
  });
  if (resp.ok) {
    await notifyMessageEditForward(botToken, message.chat.id, message.message_id);
  }
}

// ─── Delete Message ──────────────────────────────────────────────────

export async function processPMDeleteReceived(botToken, env, ownerUid, message, reply) {
  const connection = await getConnectionByPm(env, reply.chat.id, reply.message_id);
  if (!connection) return;
  await postToTelegramApi(botToken, 'deleteMessage', {
    chat_id: connection.superGroupChatId,
    message_id: connection.topicMsgId,
  });
}

export async function processPMDeleteSent(botToken, env, message, reply) {
  const connection = await getConnectionByTopic(env, message.message_thread_id, reply.message_id);
  if (!connection) return;
  await postToTelegramApi(botToken, 'deleteMessage', {
    chat_id: connection.pmChatId,
    message_id: connection.pmMsgId,
  });
}

// ─── Ban / Unban ─────────────────────────────────────────────────────

export async function banTopic(botToken, env, message, isSilent) {
  const topicId = message.message_thread_id;
  const topic = await setTopicBanned(env, topicId, true);
  if (!topic) {
    await postToTelegramApi(botToken, 'sendMessage', {
      chat_id: message.chat.id,
      message_thread_id: topicId,
      text: '未找到话题映射',
    });
    return new Response('OK');
  }

  await postToTelegramApi(botToken, 'sendMessage', {
    chat_id: message.chat.id,
    message_thread_id: topicId,
    text: '已将Ta关入小黑屋',
  });

  if (isSilent) return new Response('OK');
  await postToTelegramApi(botToken, 'sendMessage', {
    chat_id: topic.fromChatId,
    text:
      '⛔️ *消息已被拒收*\n\n' +
      '很抱歉 由于您的不当行为\n' +
      '凉心已将您关入小黑屋\n' +
      '暂时无法继续对话\n\n' +
      'TAT',
    parse_mode: 'MarkdownV2',
  });
  return new Response('OK');
}

export async function unbanTopic(botToken, env, message, isSilent) {
  const topicId = message.message_thread_id;
  const topic = await setTopicBanned(env, topicId, false);
  if (!topic) {
    await postToTelegramApi(botToken, 'sendMessage', {
      chat_id: message.chat.id,
      message_thread_id: topicId,
      text: '未找到话题映射',
    });
    return new Response('OK');
  }

  await postToTelegramApi(botToken, 'sendMessage', {
    chat_id: message.chat.id,
    message_thread_id: topicId,
    text: '已将Ta从小黑屋中放了出来',
  });

  if (isSilent) return new Response('OK');
  await postToTelegramApi(botToken, 'sendMessage', {
    chat_id: topic.fromChatId,
    text:
      '✅ *消息限制已解除*\n\n' +
      '由于您表现良好\n' +
      '凉心将你从小黑屋中放了出来\n' +
      '消息将继续转发\n\n' +
      'OvO',
    parse_mode: 'MarkdownV2',
  });
  return new Response('OK');
}

// ─── Internal helpers ────────────────────────────────────────────────

function buildTopicName(fromChat) {
  const name = [fromChat.first_name, fromChat.last_name].filter(Boolean).join(' ') || fromChat.username || 'PM';
  return name.substring(0, 127);
}

async function sendTopicUserInfo(botToken, superGroupChatId, topicId, fromChat, fromChatId) {
  const safeName = escapeMd([fromChat.first_name, fromChat.last_name].filter(Boolean).join(' ') || `${fromChatId}`);
  let userInfoText = `*昵称*: ${safeName}\n`;
  if (fromChat.username) {
    userInfoText += `*用户名*: @${escapeMd(fromChat.username)}\n`;
  }
  userInfoText += `*用户ID*: \`${fromChatId}\`\n`;

  const timeString = escapeMd(chinaTime());
  userInfoText += `*发起时间*: ${timeString}\n\n *ʚ 请始终保持冷静理性回复 ɞ*`;

  const resp = await (
    await postToTelegramApi(botToken, 'sendMessage', {
      chat_id: superGroupChatId,
      message_thread_id: topicId,
      text: userInfoText,
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔍 查看主页', url: `tg://user?id=${fromChatId}` }],
        ],
      },
    })
  ).json();

  if (resp.ok) {
    await postToTelegramApi(botToken, 'pinChatMessage', {
      chat_id: superGroupChatId,
      message_id: resp.result.message_id,
      message_thread_id: topicId,
    });
  }
}

async function notifyMessageEditForward(botToken, chatId, messageId) {
  await postToTelegramApi(botToken, 'setMessageReaction', {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji: '🦄' }],
  });
  // Wait 1s then restore 🕊 (must await — Workers isolate may recycle before setTimeout fires)
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await postToTelegramApi(botToken, 'setMessageReaction', {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji: '🕊' }],
  });
}
