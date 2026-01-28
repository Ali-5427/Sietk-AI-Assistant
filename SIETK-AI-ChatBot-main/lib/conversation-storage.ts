// Conversation storage using Vercel KV (Redis)
// Stores user conversations and enables context-aware responses

import { logger } from './logger'

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface ConversationSession {
  userId: string
  messages: ConversationMessage[]
  createdAt: number
  lastAccessedAt: number
}

/**
 * Store conversation in memory (fallback if Vercel KV not available)
 * In production, replace with actual Vercel KV calls
 */
const conversationStore = new Map<string, ConversationSession>()

// Clean up old conversations every hour
setInterval(() => {
  const now = Date.now()
  const maxAge = 24 * 60 * 60 * 1000 // 24 hours
  let cleaned = 0

  for (const [userId, session] of conversationStore) {
    if (now - session.lastAccessedAt > maxAge) {
      conversationStore.delete(userId)
      cleaned++
    }
  }

  if (cleaned > 0) {
    logger.info('conversation-storage', `Cleaned up ${cleaned} old conversations`)
  }
}, 60 * 60 * 1000)

/**
 * Get conversation history for a user
 */
export async function getConversation(userId: string): Promise<ConversationMessage[]> {
  try {
    const session = conversationStore.get(userId)
    if (!session) {
      return []
    }

    // Update last accessed time
    session.lastAccessedAt = Date.now()

    // Return last 10 messages to keep context window reasonable
    return session.messages.slice(-10)
  } catch (error) {
    logger.error('conversation-storage', 'Failed to retrieve conversation', error as Error, { userId })
    return []
  }
}

/**
 * Add message to conversation history
 */
export async function addToConversation(userId: string, message: ConversationMessage): Promise<void> {
  try {
    let session = conversationStore.get(userId)

    if (!session) {
      session = {
        userId,
        messages: [],
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
      }
      conversationStore.set(userId, session)
    }

    session.messages.push(message)
    session.lastAccessedAt = Date.now()

    // Limit to last 50 messages per conversation
    if (session.messages.length > 50) {
      session.messages = session.messages.slice(-50)
    }

    logger.debug('conversation-storage', `Added message to conversation`, {
      userId,
      role: message.role,
      contentLength: message.content.length,
    })
  } catch (error) {
    logger.error('conversation-storage', 'Failed to add message to conversation', error as Error, { userId })
  }
}

/**
 * Clear conversation history (user privacy/reset)
 */
export async function clearConversation(userId: string): Promise<void> {
  try {
    conversationStore.delete(userId)
    logger.info('conversation-storage', 'Conversation cleared', { userId })
  } catch (error) {
    logger.error('conversation-storage', 'Failed to clear conversation', error as Error, { userId })
  }
}

/**
 * Get summary of conversation for analytics
 */
export async function getConversationStats(userId: string): Promise<{
  messageCount: number
  firstMessageTime: number | null
  lastMessageTime: number | null
  averageMessageLength: number
} | null> {
  try {
    const session = conversationStore.get(userId)
    if (!session || session.messages.length === 0) {
      return null
    }

    const messages = session.messages
    const totalLength = messages.reduce((sum, msg) => sum + msg.content.length, 0)

    return {
      messageCount: messages.length,
      firstMessageTime: messages[0]?.timestamp || null,
      lastMessageTime: messages[messages.length - 1]?.timestamp || null,
      averageMessageLength: Math.round(totalLength / messages.length),
    }
  } catch (error) {
    logger.error('conversation-storage', 'Failed to get conversation stats', error as Error, { userId })
    return null
  }
}

/**
 * Generate user ID from IP + user agent (for anonymous tracking)
 */
export function generateUserId(ip: string, userAgent: string): string {
  const crypto = require('crypto')
  const combined = `${ip}-${userAgent}`
  return crypto.createHash('sha256').update(combined).digest('hex').substring(0, 16)
}

/**
 * TODO: Implement Vercel KV integration
 * Currently using in-memory store, but for production you should use:
 *
 * import { kv } from '@vercel/kv'
 *
 * export async function getConversation(userId: string): Promise<ConversationMessage[]> {
 *   const conversation = await kv.get(`conversation:${userId}`)
 *   return conversation || []
 * }
 *
 * export async function addToConversation(userId: string, message: ConversationMessage): Promise<void> {
 *   const key = `conversation:${userId}`
 *   const current = (await kv.get(key)) || []
 *   current.push(message)
 *   await kv.set(key, current.slice(-50), { ex: 86400 * 7 }) // 7 days TTL
 * }
 */
