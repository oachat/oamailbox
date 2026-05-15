/**
 * Mailbox — Cloudflare Worker Entry Point
 * A personal two-way private messaging Telegram bot.
 *
 * Architecture:
 *   worker.js (entry + router)
 *     → handlers/  (webhook, verify, commands)
 *     → services/  (auth, topic)
 *     → lib/       (telegram, crypto, kv, markdown)
 *
 * Environment:
 *   Vars  — PREFIX, MINIAPP_URL, OWNER_UID
 *   Secrets — BOT_TOKEN, SECRET_TOKEN, TURNSTILE_SECRET
 *   Bindings — KV
 */

import { handleWebhook } from './handlers/webhook.js';
import { handleVerifyApi } from './handlers/verify.js';
import { postToTelegramApi, jsonResponse, corsHeaders } from './lib/telegram.js';
import { timingSafeEqual } from './lib/crypto.js';

const ALLOWED_UPDATES = ['message', 'message_reaction', 'edited_message'];

export default {
  async fetch(request, env, ctx) {
    const config = {
      prefix: env.PREFIX || 'public',
      secretToken: env.SECRET_TOKEN || '',
      miniAppUrl: env.MINIAPP_URL || '',
      botToken: env.BOT_TOKEN || '',
      ownerUid: env.OWNER_UID || '',
    };

    try {
      return await routeRequest(request, env, config);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({
        message: 'unhandled worker error',
        error: msg,
        path: new URL(request.url).pathname,
      }));
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};

// ─── Router ──────────────────────────────────────────────────────────

async function routeRequest(request, env, config) {
  const { prefix } = config;
  const url = new URL(request.url);
  const path = url.pathname;

  // One-time webhook registration: GET /{prefix}/setup?token=SECRET_TOKEN
  if (path === `/${prefix}/setup`) {
    return handleSetup(url, config);
  }

  // Telegram webhook endpoint
  if (path === `/${prefix}/webhook`) {
    return handleWebhook(request, env, config);
  }

  // Verification API (with or without trailing path segments for compat)
  if (path === `/${prefix}/api/verify` || path.startsWith(`/${prefix}/api/verify/`)) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    return handleVerifyApi(request, env, config);
  }

  return new Response('Not Found', { status: 404 });
}

// ─── Setup ───────────────────────────────────────────────────────────
// Registers the Telegram webhook. Call once after deploying:
//   curl "https://<worker>/public/setup?token=YOUR_SECRET_TOKEN"

async function handleSetup(url, config) {
  const { botToken, secretToken, prefix } = config;

  if (!botToken || !secretToken) {
    return jsonResponse({ success: false, error: 'BOT_TOKEN or SECRET_TOKEN not configured' }, 500);
  }

  const token = url.searchParams.get('token');
  if (!token || !(await timingSafeEqual(token, secretToken))) {
    return new Response('Unauthorized', { status: 401 });
  }

  const webhookUrl = `${url.origin}/${prefix}/webhook`;
  try {
    const resp = await (
      await postToTelegramApi(botToken, 'setWebhook', {
        url: webhookUrl,
        allowed_updates: ALLOWED_UPDATES,
        secret_token: secretToken,
      })
    ).json();

    if (resp.ok) {
      return jsonResponse({ success: true, message: 'Webhook registered', webhookUrl });
    }
    return jsonResponse({ success: false, message: resp.description }, 400);
  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, 500);
  }
}
