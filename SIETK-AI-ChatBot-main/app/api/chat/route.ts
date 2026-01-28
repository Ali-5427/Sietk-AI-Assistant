import { searchKnowledgeBase, getSystemPrompt, SIETK_KNOWLEDGE_BASE } from "@/lib/sietk-knowledge-base"
import { searchSIETKWebsite } from "@/lib/exa-search"
import { checkRateLimit } from "@/lib/rate-limiter"
import { validateChatRequest, getClientIp } from "@/lib/input-validation"
import { logger } from "@/lib/logger"
import { validateResponse, addConfidenceIndicator } from "@/lib/response-validator"
import { getConversation, addToConversation, generateUserId, type ConversationMessage } from "@/lib/conversation-storage"
import { fetchWithTimeout, executeWithRetry, checkCircuitBreaker, recordCircuitBreakerFailure, recordCircuitBreakerSuccess } from "@/lib/timeout-retry"

export const maxDuration = 60

// Gemini API Configuration - using v1beta API
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent"

export async function POST(req: Request) {
  const startTime = Date.now()

  try {
    // ============================================
    // STEP 0: Rate Limiting & Validation
    // ============================================
    const clientIp = getClientIp(req)
    const rateLimit = checkRateLimit(clientIp)

    if (!rateLimit.allowed) {
      logger.warn('rate-limiter', 'Rate limit exceeded', { ip: clientIp, retryAfter: rateLimit.retryAfter })
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(rateLimit.retryAfter),
          },
        },
      )
    }

    // Validate request format
    const requestData = await req.json()
    const validation = validateChatRequest(requestData)

    if (!validation.valid) {
      logger.warn('input-validation', 'Invalid chat request', { ip: clientIp, error: validation.error })
      return new Response(
        JSON.stringify({ error: validation.error }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const { messages } = validation
    const userAgent = req.headers.get('user-agent') || 'unknown'
    const userId = generateUserId(clientIp, userAgent)

    // Get the latest user message
    const latestUserMessage = messages[messages.length - 1]
    const userQuery = latestUserMessage.content

    logger.info('chat-api', 'New query received', {
      userId,
      queryLength: userQuery.length,
      messagesCount: messages.length,
    })

    // ============================================
    // STEP 1: Retrieve Conversation History
    // ============================================
    const conversationHistory = await getConversation(userId)

    // ============================================
    // STEP 2: Search Knowledge Base
    // ============================================
    logger.info('chat-api', 'Searching knowledge base', { userId })
    const knowledgeBaseResult = searchKnowledgeBase(userQuery)

    // ============================================
    // STEP 3: Search Exa for Real-Time Info
    // ============================================
    let exaResult = ""
    if (checkCircuitBreaker('exa-search')) {
      try {
        exaResult = await executeWithRetry(
          () => searchSIETKWebsite(userQuery),
          'exa-search',
          { maxRetries: 2, initialDelayMs: 500 }
        )
        recordCircuitBreakerSuccess('exa-search')
      } catch (error) {
        logger.warn('exa-search', 'Exa search failed', error as Error, { userId })
        recordCircuitBreakerFailure('exa-search')
      }
    } else {
      logger.warn('circuit-breaker', 'Exa service circuit breaker is OPEN, skipping search', { userId })
    }

    // ============================================
    // STEP 4: Use Gemini AI to Synthesize Response
    // ============================================
    const geminiApiKey = process.env.GEMINI_API_KEY?.trim()

    if (!geminiApiKey) {
      logger.warn('chat-api', 'No Gemini API key configured, using knowledge base only', { userId })
      const fallbackResponse =
        knowledgeBaseResult || "I apologize, but I don't have specific information about that. Please contact SIETK at 08577-264999 or visit https://sietk.org"

      // Store in conversation
      await addToConversation(userId, {
        role: 'user',
        content: userQuery,
        timestamp: Date.now(),
      })
      await addToConversation(userId, {
        role: 'assistant',
        content: fallbackResponse,
        timestamp: Date.now(),
      })

      return createStreamResponse(fallbackResponse)
    }

    logger.info('chat-api', 'Calling Gemini API', { userId })

    // Build the AI prompt with all gathered information
    const aiPrompt = buildAIPrompt(userQuery, knowledgeBaseResult, exaResult, [...conversationHistory, ...messages])

    // Call Gemini API with timeout and retry
    let aiResponse = ""

    if (checkCircuitBreaker('gemini')) {
      try {
        const geminiResult = await executeWithRetry(
          () =>
            fetchWithTimeout(`${GEMINI_API_URL}?key=${geminiApiKey}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                contents: [
                  {
                    parts: [{ text: aiPrompt }],
                  },
                ],
                generationConfig: {
                  temperature: 0.7,
                  topK: 40,
                  topP: 0.95,
                  maxOutputTokens: 1024,
                },
                safetySettings: [
                  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
                  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
                  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
                ],
              }),
              timeout: 30000,
            }),
          'gemini-api',
          { maxRetries: 2, initialDelayMs: 1000 }
        )

        if (!geminiResult.ok) {
          throw new Error(`Gemini API error: ${geminiResult.status}`)
        }

        const geminiData = await geminiResult.json()
        aiResponse = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || ""
        recordCircuitBreakerSuccess('gemini')
      } catch (error) {
        logger.error('gemini-api', 'Gemini API failed', error as Error, { userId })
        recordCircuitBreakerFailure('gemini')

        // Try Groq as fallback
        logger.info('groq-fallback', 'Attempting Groq fallback', { userId })
        const groqApiKey = process.env.GROQ_API_KEY?.trim()

        if (groqApiKey && checkCircuitBreaker('groq')) {
          try {
            const groqResult = await executeWithRetry(
              () =>
                fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${groqApiKey}`,
                  },
                  body: JSON.stringify({
                    model: 'llama-3.1-8b-instant',
                    messages: [
                      { role: 'system', content: aiPrompt },
                      { role: 'user', content: userQuery },
                    ],
                    max_tokens: 1024,
                    temperature: 0.7,
                  }),
                  timeout: 30000,
                }),
              'groq-api',
              { maxRetries: 1, initialDelayMs: 500 }
            )

            if (groqResult.ok) {
              const groqData = await groqResult.json()
              aiResponse = groqData.choices?.[0]?.message?.content || ""
              recordCircuitBreakerSuccess('groq')
              logger.info('groq-fallback', 'Groq fallback successful', { userId })
            } else {
              throw new Error(`Groq API error: ${groqResult.status}`)
            }
          } catch (groqError) {
            logger.error('groq-fallback', 'Groq fallback failed', groqError as Error, { userId })
            recordCircuitBreakerFailure('groq')
          }
        }
      }
    } else {
      logger.warn('circuit-breaker', 'Gemini circuit breaker is OPEN, using knowledge base only', { userId })
    }

    // If we still don't have a response, use knowledge base
    if (!aiResponse.trim()) {
      logger.warn('fallback', 'Using knowledge base fallback', { userId })
      aiResponse =
        knowledgeBaseResult || "I apologize, but I'm having trouble processing your request. Please try again or contact SIETK at 08577-264999."
    }

    // ============================================
    // STEP 5: Validate Response Quality
    // ============================================
    const validation_result = validateResponse(aiResponse, userQuery)
    if (!validation_result.isValid) {
      logger.warn('response-validator', 'Low confidence response detected', {
        userId,
        confidence: validation_result.confidence,
        issues: validation_result.issues,
      })
      // Add confidence indicator to response
      aiResponse = addConfidenceIndicator(aiResponse, validation_result.confidence)
    } else {
      logger.debug('response-validator', 'Response validated successfully', {
        userId,
        confidence: validation_result.confidence,
      })
    }

    // ============================================
    // STEP 6: Store in Conversation History
    // ============================================
    await addToConversation(userId, {
      role: 'user',
      content: userQuery,
      timestamp: Date.now(),
    })
    await addToConversation(userId, {
      role: 'assistant',
      content: aiResponse,
      timestamp: Date.now(),
    })

    const duration = Date.now() - startTime
    logger.info('chat-api', 'Response sent successfully', {
      userId,
      durationMs: duration,
      responseLength: aiResponse.length,
      confidence: validation_result.confidence,
    })

    return createStreamResponse(aiResponse)
  } catch (error) {
    const duration = Date.now() - startTime
    logger.error('chat-api', 'Unhandled error in chat endpoint', error as Error, { durationMs: duration })

    return new Response(
      JSON.stringify({
        error: 'An unexpected error occurred. Please try again later.',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }
}

// Build AI prompt with conversation history and all gathered information
function buildAIPrompt(
  userQuery: string,
  knowledgeBase: string | null,
  exaResult: string,
  conversationHistory: Array<{ role: string; content: string }>
): string {
  const systemContext = `You are SIETK Assistant, an intelligent AI for Siddharth Institute of Engineering and Technology, Puttur, Andhra Pradesh.

YOUR ROLE:
- Give accurate, helpful, and detailed answers about SIETK
- Use ALL provided information (knowledge base + web search) to create comprehensive answers
- Remember previous conversation context and provide consistent answers
- If the user asks about something specific, give specific details
- Be professional yet friendly

RESPONSE FORMAT (MUST FOLLOW):
1. Start with a main heading using ## (e.g., "## Topic Name 🎓")
2. Organize content into sections with **bold labels**
3. Use bullet points (-) for lists
4. Include specific details like numbers, dates, names
5. End with contact info: 📞 08577-264999 | 🌐 https://sietk.org

CRITICAL RULES (MUST FOLLOW):
1. ONLY use information from the knowledge base and web search results provided
2. NEVER make up information, coordinates, fake links, or data not provided
3. If confidence is low, say "Please contact SIETK for details"
4. Do NOT create fake URLs or links
5. Keep responses accurate and factual
6. Reference previous answers if user is following up on earlier question

SIETK FACTS (USE ONLY THESE):
- Established: 2001 by Dr. K. Ashok Raju
- Full Address: Siddharth Nagar, Narayanavanam Road, Puttur - 517583, Andhra Pradesh
- Affiliation: JNTUA (Autonomous since 2013)
- Phone: 08577-264999
- Email: principal.f6@jntua.ac.in
- Website: https://sietk.org`

  let prompt = systemContext + '\n\n'

  // Add knowledge base information if available
  if (knowledgeBase) {
    const cleanedKB = knowledgeBase.replace(
      /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|📚|📞|🌐|🏆|🎓|💼|💰|📋|🏛️|👨‍💼|👨‍🏫|📝|💻|📊/gu,
      ''
    )
    prompt += `KNOWLEDGE BASE INFORMATION:\n${cleanedKB}\n\n`
  }

  // Add Exa search results if available
  if (exaResult && exaResult.trim()) {
    prompt += `REAL-TIME WEB SEARCH RESULTS:\n${exaResult}\n\n`
  }

  // Add conversation history (last 4 exchanges for context)
  const recentHistory = conversationHistory.slice(-8).filter(msg => msg.role !== 'system')
  if (recentHistory.length > 0) {
    prompt += 'CONVERSATION HISTORY:\n'
    for (const msg of recentHistory) {
      prompt += `${msg.role.toUpperCase()}: ${msg.content}\n`
    }
    prompt += '\n'
  }

  // Add current user query
  prompt += `USER'S CURRENT QUESTION:\n${userQuery}\n\n`

  prompt += `YOUR RESPONSE (use emojis for engagement):`

  return prompt
}

// Create a streaming response for frontend compatibility
function createStreamResponse(text: string): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
