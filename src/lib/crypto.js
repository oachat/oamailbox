/**
 * Security helpers: timing-safe comparison,
 * Telegram initData verification, and Cloudflare Turnstile verification.
 */

import { cleanBotToken } from './telegram.js';

/**
 * Constant-time string comparison.
 * Hashes both values with SHA-256 first to avoid length-leak via timing.
 */
export async function timingSafeEqual(a, b) {
  if (!a || !b) return false;
  const encoder = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(hashA, hashB);
}

// --- Telegram initData verification ---

export async function verifyTelegramInitData(initData, botToken) {
  try {
    const cleanToken = cleanBotToken(botToken);
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { valid: false };

    params.delete('hash');
    const sortedKeys = Array.from(params.keys()).sort();
    const dataCheckString = sortedKeys.map((key) => `${key}=${params.get(key)}`).join('\n');

    const encoder = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const tokenKey = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(cleanToken));
    const dataKey = await crypto.subtle.importKey(
      'raw',
      tokenKey,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', dataKey, encoder.encode(dataCheckString));
    const computedHash = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    if (computedHash !== hash) return { valid: false };

    const userParam = params.get('user');
    if (!userParam) return { valid: false };

    const user = JSON.parse(userParam);
    return { valid: true, userId: user.id };
  } catch {
    return { valid: false };
  }
}

// --- Cloudflare Turnstile verification ---

export async function verifyTurnstileToken(token, secret) {
  try {
    const cleanSecret = secret?.replace(/^\uFEFF/, '').trim() || '';
    if (!token || !cleanSecret) {
      return { success: false, error: 'Missing token or secret' };
    }

    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: cleanSecret, response: token }),
    });

    const data = await response.json();
    if (!data.success) {
      return { success: false, error: 'Turnstile verification failed', details: data };
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: 'Exception during verification', details: error?.message };
  }
}
