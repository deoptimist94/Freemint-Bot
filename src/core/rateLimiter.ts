/**
 * Rate Limiter for User Actions - Prevents RPC Abuse
 */

interface UserRateLimit {
  requests: number;
  windowStart: number;
}

const userLimits = new Map<string, UserRateLimit>();

const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_MINUTE = 10; // 10 commands per minute per user

export function checkRateLimit(userId: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const limit = userLimits.get(userId);

  if (!limit) {
    userLimits.set(userId, { requests: 1, windowStart: now });
    return { allowed: true };
  }

  // Reset window if expired
  if (now - limit.windowStart > RATE_LIMIT_WINDOW) {
    userLimits.set(userId, { requests: 1, windowStart: now });
    return { allowed: true };
  }

  // Check limit
  if (limit.requests >= MAX_REQUESTS_PER_MINUTE) {
    const retryAfter = Math.ceil((RATE_LIMIT_WINDOW - (now - limit.windowStart)) / 1000);
    return { allowed: false, retryAfter };
  }

  limit.requests++;
  return { allowed: true };
}

// Cleanup old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [userId, limit] of userLimits) {
    if (now - limit.windowStart > RATE_LIMIT_WINDOW * 2) {
      userLimits.delete(userId);
    }
  }
}, 300000); // Every 5 minutes
