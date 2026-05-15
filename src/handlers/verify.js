/**
 * Verification API endpoint handler.
 * POST /{prefix}/api/verify
 */

import { postToTelegramApi, corsHeaders, chinaTime } from '../lib/telegram.js';
import { verifyTelegramInitData, verifyTurnstileToken } from '../lib/crypto.js';
import {
  getAllVerifyPrompts,
  deleteVerifyPrompt,
  setVerifyPending,
  saveUser,
} from '../lib/kv.js';

export async function handleVerifyApi(request, env, config) {
  const { botToken } = config;

  try {
    const body = await request.json();
    const { initData, turnstileToken } = body || {};

    if (!initData || !turnstileToken) {
      return jsonCors({ success: false, error: 'Missing required fields' }, 400);
    }

    if (!botToken) {
      return jsonCors({ success: false, error: 'Bot token not configured' }, 500);
    }

    // Verify Telegram initData
    const initDataResult = await verifyTelegramInitData(initData, botToken);
    if (!initDataResult.valid || !initDataResult.userId) {
      return jsonCors({ success: false, error: 'Invalid Telegram data' }, 403);
    }

    // Verify Turnstile
    const turnstileResult = await verifyTurnstileToken(turnstileToken, env.TURNSTILE_SECRET);
    if (!turnstileResult.success) {
      return jsonCors({
        success: false,
        error: turnstileResult.error,
        details: turnstileResult.details,
      }, 403);
    }

    // Save verified state
    await saveUser(env, {
      id: initDataResult.userId,
      verified: true,
      verifiedAt: chinaTime(),
    });

    // Mark pending as done (don't delete — used as KV lag fallback)
    await setVerifyPending(env, initDataResult.userId, 'done');

    // Notify user (best-effort)
    const promptList = await getAllVerifyPrompts(env, initDataResult.userId);
    const promptMessageId = promptList.length ? promptList[promptList.length - 1] : null;
    if (promptMessageId) {
      await postToTelegramApi(botToken, 'editMessageText', {
        chat_id: initDataResult.userId,
        message_id: promptMessageId,
        text: '已完成验证，现在可以继续和oa对话了~',
      });
    } else {
      await postToTelegramApi(botToken, 'sendMessage', {
        chat_id: initDataResult.userId,
        text: '已完成验证，现在可以继续和oa对话了~',
      });
    }

    // Clean up remaining prompts
    for (const mid of promptList) {
      if (mid === promptMessageId) continue;
      await postToTelegramApi(botToken, 'deleteMessage', {
        chat_id: initDataResult.userId,
        message_id: mid,
      });
    }
    await deleteVerifyPrompt(env, initDataResult.userId);

    // Fetch user avatar (best-effort)
    let photoUrl = null;
    try {
      const photosResp = await (await postToTelegramApi(botToken, 'getUserProfilePhotos', {
        user_id: initDataResult.userId, offset: 0, limit: 1,
      })).json();
      const fileId = photosResp?.result?.photos?.[0]?.[0]?.file_id;
      if (fileId) {
        const fileResp = await (await postToTelegramApi(botToken, 'getFile', { file_id: fileId })).json();
        const filePath = fileResp?.result?.file_path;
        if (filePath) photoUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
      }
    } catch (_) { /* ignore */ }

    return jsonCors({ success: true, photoUrl }, 200);
  } catch (error) {
    console.error(JSON.stringify({ message: 'verify API error', error: error?.message }));
    return jsonCors({ success: false, error: error?.message || 'Internal error' }, 500);
  }
}

// --- Internal ---

function jsonCors(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
