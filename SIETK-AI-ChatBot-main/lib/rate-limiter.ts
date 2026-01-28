// Rate limiter to prevent API quota exhaustion
// Limits: 10 requests per IP per minute

interface RateLimitStore {
  [ip: string]: { count: number; resetTime: number }
}

const rateLimitStore: RateLimitStore = {}
const LIMIT = 10 // requests per minute
const WINDOW = 60 * 1000 // 1 minute in milliseconds

export function checkRateLimit(ip: string): { allowed: boolean; remaining: number; retryAfter: number } {
  const now = Date.now()
  const record = rateLimitStore[ip]

  // New IP or window expired
  if (!record || now > record.resetTime) {
    rateLimitStore[ip] = { count: 1, resetTime: now + WINDOW }
    return { allowed: true, remaining: LIMIT - 1, retryAfter: 0 }
  }

  // Within window
  if (record.count < LIMIT) {
    record.count++
    return { allowed: true, remaining: LIMIT - record.count, retryAfter: 0 }
  }

  // Limit exceeded
  const retryAfter = Math.ceil((record.resetTime - now) / 1000)
  return { allowed: false, remaining: 0, retryAfter }
}

// Clean up old entries every hour to prevent memory leak
setInterval(() => {
  const now = Date.now()
  for (const ip in rateLimitStore) {
    if (now > rateLimitStore[ip].resetTime) {
      delete rateLimitStore[ip]
    }
  }
}, 60 * 60 * 1000)
