/**
 * Bot command handlers: /start and admin dot-commands.
 */

import { postToTelegramApi } from '../lib/telegram.js';
import { getUser } from '../lib/kv.js';
import { isVerifyEnabled, sendVerifyPrompt } from '../services/auth.js';
import {
  init,
  checkInit,
  reset,
  banTopic,
  unbanTopic,
} from '../services/topic.js';

// ─── /start ──────────────────────────────────────────────────────────

export async function handleStartCommand(
  botToken, ownerUid, env, miniAppUrl,
  fromUser, fromChat, message,
  workerOrigin, prefix,
) {
  let introduction =
    '*欢迎使用oa的传话筒 📪*' +
    '\n>我是一个双向私聊机器人\\.' +
    '\n>可以帮助你与oa进行沟通\\.' +
    '\n*📌 使用说明*:' +
    '\n>*表情回应*:' +
    '\n>  下面的表情 🕊 代表消息已经成功转发\\.' +
    '\n>  如果你没有看到这个表情，说明消息没有被转发成功\\.' +
    '\n>  你可以为自己或我的消息点击其他表情\\(除了这个\\), 我也会把它们转发\\.' +
    '\n>  但是作为机器人, 我只能在每条消息上发送一个免费的表情回应\\.' +
    '\n>  如果你是 TG 大会员, 点了多个表情回应，我只会转发最后一个免费的\\.||' +
    '\n' +
    '\n>*编辑消息*:' +
    '\n>  你可以像平常一样编辑消息, 但目前仅支持编辑文本内容\\. ' +
    '如果转发成功, 表情 🦄 会迅速出现, 1 秒后会恢复为 🕊 \\.' +
    '\n>  如果你没看到这个表情，说明编辑的消息没有被转发\\.' +
    '\n>  如果没转发成功，你可以尝试用不同的内容再编辑一次\\.||' +
    '\n' +
    '\n>*删除消息*:' +
    '\n>  如果你想删除我转发的消息，可以回复原消息并输入 `#del` 来删除我转发的消息\\.' +
    '\n>  但是作为机器人, 我只能删除我自己的消息, 不能删除你的消息\\. 所以你需要删除自己的消息\\.||' +
    '\n' +
    '\n*⚡️ 注意事项*:' +
    '\n>• 避免重复发送相同的消息' +
    '\n>• 请耐心等待oa回复' +
    '\n>• 若有急事请说明情况' +
    '\n>• 请保持友善和礼貌的交流态度' +
    '\n' +
    '\n*如果你想再看到这条消息*' +
    '\n*只需发送 /start 给我\\.*';

  if (fromUser.id.toString() === ownerUid) {
    introduction += buildOwnerIntroduction(fromChat, message);
  }

  const sendMessageResp = await (
    await postToTelegramApi(botToken, 'sendMessage', {
      chat_id: fromChat.id,
      text: introduction,
      message_thread_id: message.message_thread_id,
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: true },
    })
  ).json();

  if (sendMessageResp.ok) {
    await postToTelegramApi(botToken, 'setMessageReaction', {
      chat_id: fromChat.id,
      message_id: sendMessageResp.result.message_id,
      reaction: [{ type: 'emoji', emoji: '🕊' }],
    });
  } else {
    console.error(JSON.stringify({ message: 'sendMessage failed in /start', resp: sendMessageResp }));
  }

  if (isVerifyEnabled(env, miniAppUrl)) {
    const user = await getUser(env, fromUser.id);
    if (!user?.verified) {
      await sendVerifyPrompt(env, botToken, ownerUid, miniAppUrl, fromUser, fromChat, workerOrigin, prefix);
    }
  }

  return new Response('OK');
}

// ─── Admin commands ──────────────────────────────────────────────────

export async function handleForumAdminCommands(botToken, ownerUid, env, message, config) {
  const text = message.text;

  if (!message.is_topic_message) {
    // General topic commands
    switch (text) {
      case '.check':
        return await checkInit(botToken, ownerUid, env, message);
      case '.init':
        return await init(botToken, ownerUid, env, message);
      case '.reset':
        return await reset(botToken, ownerUid, env, message, false);
    }
  } else {
    // PM topic commands
    if (!config?.superGroupChatId || message.chat.id !== config.superGroupChatId) {
      await postToTelegramApi(botToken, 'sendMessage', {
        chat_id: message.chat.id,
        text: 'Only can work in your PM super group',
      });
      return new Response('OK');
    }
    switch (text) {
      case '.ban':
        return await banTopic(botToken, env, message, false);
      case '.unban':
        return await unbanTopic(botToken, env, message, false);
      case '.sban':
        return await banTopic(botToken, env, message, true);
      case '.sunban':
        return await unbanTopic(botToken, env, message, true);
    }
  }

  return new Response('OK');
}

export async function handleOwnerChatCommands(botToken, ownerUid, env, message) {
  if (message.text === '.reset') {
    return await reset(botToken, ownerUid, env, message, true);
  }
  return new Response('OK');
}

// ─── Internal ────────────────────────────────────────────────────────

function buildOwnerIntroduction(fromChat, message) {
  let extra =
    '\n' +
    '\n*以下内容仅对机器人管理员可见\\.*' +
    '\n' +
    '\n>*删除消息*:' +
    '\n>  只要我有足够的权限，就可以在群组中删除你发送的消息以及我自己的消息\\.' +
    '\n' +
    '\n>*获取帮助*:' +
    '\n>  本机器人完全免费使用\\.' +
    '\n>  如需帮助，请发送邮件至 *52lxcloud@gmail\\.com*\\.' +
    '\n>  或者你可以通过[凉心的传话筒](https://t.me/Lx_chatbot)联系我\\.' +
    '\n';

  if (fromChat.is_forum && message.is_topic_message) {
    extra +=
      '\n*当前会话中可用的指令:*' +
      '\n>`.ban`' +
      '\n' +
      '\n||  关入小黑屋, 停止转发消息, 并通知对方\\.||' +
      '\n>`.unban`' +
      '\n' +
      '\n||  放出小黑屋, 恢复转发消息, 并通知对方\\.||' +
      '\n>`.sban`' +
      '\n' +
      '\n||  关入小黑屋, 停止转发消息, 不通知对方\\.||' +
      '\n>`.sunban`' +
      '\n' +
      '\n||  放出小黑屋, 恢复转发消息, 不通知对方\\.||';
  } else if (fromChat.is_forum) {
    extra +=
      '\n*当前会话中可用的指令:*' +
      '\n>`.check`' +
      '\n' +
      '\n||  检查初始化状态\\.||' +
      '\n>`.init`' +
      '\n' +
      '\n||  进行初始设置\\.||' +
      '\n>`.reset`' +
      '\n' +
      '\n||  重置设置\\.||' +
      '\n' +
      '\n*结果都会回复在机器人私聊中*';
  } else {
    extra +=
      '\n*一些常用的命令:*' +
      '\n在与机器人私聊中使用:' +
      '\n>`.reset`' +
      '\n在群组的「常规话题」中使用:' +
      '\n>`.check`' +
      '\n' +
      '\n>`.init`' +
      '\n' +
      '\n>`.reset`' +
      '\n' +
      '\n*当前会话中可用的指令:*' +
      '\n>`.reset`' +
      '\n' +
      '\n||重置设置\\.||';
  }

  return extra;
}
