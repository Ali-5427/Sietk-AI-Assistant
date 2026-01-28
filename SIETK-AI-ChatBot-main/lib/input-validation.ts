// Input validation to prevent injection attacks and malformed requests

export function validateChatRequest(data: unknown): {
  valid: boolean
  messages?: Array<{ role: string; content: string }>
  error?: string
} {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Invalid request format' }
  }

  const request = data as Record<string, unknown>

  if (!Array.isArray(request.messages)) {
    return { valid: false, error: 'Messages must be an array' }
  }

  if (request.messages.length === 0) {
    return { valid: false, error: 'At least one message is required' }
  }

  if (request.messages.length > 100) {
    return { valid: false, error: 'Too many messages (max 100)' }
  }

  const messages: Array<{ role: string; content: string }> = []

  for (const msg of request.messages) {
    if (!msg || typeof msg !== 'object') {
      return { valid: false, error: 'Each message must be an object' }
    }

    const message = msg as Record<string, unknown>

    if (typeof message.role !== 'string' || !['user', 'assistant', 'system'].includes(message.role)) {
      return { valid: false, error: 'Invalid message role' }
    }

    if (typeof message.content !== 'string') {
      return { valid: false, error: 'Message content must be a string' }
    }

    const content = message.content.trim()

    if (content.length === 0) {
      return { valid: false, error: 'Message content cannot be empty' }
    }

    if (content.length > 5000) {
      return { valid: false, error: 'Message too long (max 5000 characters)' }
    }

    // Check for potential injection attacks
    if (content.includes('<script') || content.includes('javascript:') || content.includes('onerror=')) {
      return { valid: false, error: 'Invalid content detected' }
    }

    messages.push({
      role: message.role,
      content: sanitizeInput(content),
    })
  }

  return { valid: true, messages }
}

// Sanitize input to prevent XSS
function sanitizeInput(input: string): string {
  return input
    .replace(/[<>]/g, '') // Remove angle brackets
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+\s*=/gi, '') // Remove event handlers
    .trim()
}

// Get client IP from request
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    return forwarded.split(',')[0].trim()
  }

  const ip = request.headers.get('x-real-ip')
  if (ip) {
    return ip
  }

  // Fallback - this won't work in production but ok for development
  return 'unknown'
}
