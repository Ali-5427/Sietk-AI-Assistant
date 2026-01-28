// Timeout and retry logic with exponential backoff and circuit breaker pattern

import { logger } from './logger'

export interface RetryOptions {
  maxRetries?: number
  initialDelayMs?: number
  maxDelayMs?: number
  backoffMultiplier?: number
}

export interface CircuitBreakerState {
  failures: number
  lastFailureTime: number
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'
}

const circuitBreakers = new Map<string, CircuitBreakerState>()

/**
 * Fetch with timeout
 */
export async function fetchWithTimeout(url: string, options: RequestInit & { timeout?: number } = {}): Promise<Response> {
  const timeout = options.timeout || 30000 // Default 30 seconds

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })

    clearTimeout(timeoutId)
    return response
  } catch (error) {
    clearTimeout(timeoutId)

    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms`)
    }

    throw error
  }
}

/**
 * Execute with retry and exponential backoff
 */
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  operationName: string,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3
  const initialDelay = options.initialDelayMs ?? 1000
  const maxDelay = options.maxDelayMs ?? 10000
  const backoffMultiplier = options.backoffMultiplier ?? 2

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      logger.debug('retry-logic', `Executing ${operationName} (attempt ${attempt + 1}/${maxRetries + 1})`)

      const result = await fn()
      if (attempt > 0) {
        logger.info('retry-logic', `${operationName} succeeded after ${attempt} retries`)
      }
      return result
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt < maxRetries) {
        const delay = Math.min(initialDelay * Math.pow(backoffMultiplier, attempt), maxDelay)
        logger.warn('retry-logic', `${operationName} failed, retrying in ${delay}ms`, {
          operation: operationName,
          attempt: attempt + 1,
          error: lastError.message,
        })

        await sleep(delay)
      } else {
        logger.error('retry-logic', `${operationName} failed after ${maxRetries} retries`, lastError, {
          operation: operationName,
        })
      }
    }
  }

  throw lastError || new Error(`${operationName} failed`)
}

/**
 * Circuit breaker pattern to prevent cascading failures
 * Stops calling failing service if failure rate is high
 */
export function checkCircuitBreaker(serviceName: string): boolean {
  let breaker = circuitBreakers.get(serviceName)

  if (!breaker) {
    breaker = { failures: 0, lastFailureTime: 0, state: 'CLOSED' }
    circuitBreakers.set(serviceName, breaker)
  }

  const now = Date.now()

  // Reset if service has been down for more than 1 minute (HALF_OPEN → CLOSED)
  if (breaker.state === 'OPEN' && now - breaker.lastFailureTime > 60000) {
    logger.info('circuit-breaker', `Circuit breaker for ${serviceName} transitioning to HALF_OPEN`)
    breaker.state = 'HALF_OPEN'
    breaker.failures = 0
  }

  return breaker.state !== 'OPEN'
}

/**
 * Record failure in circuit breaker
 */
export function recordCircuitBreakerFailure(serviceName: string): void {
  let breaker = circuitBreakers.get(serviceName)

  if (!breaker) {
    breaker = { failures: 0, lastFailureTime: 0, state: 'CLOSED' }
    circuitBreakers.set(serviceName, breaker)
  }

  breaker.failures++
  breaker.lastFailureTime = Date.now()

  // Open circuit if 5+ failures
  if (breaker.failures >= 5 && breaker.state !== 'OPEN') {
    logger.error('circuit-breaker', `Circuit breaker OPENED for ${serviceName} after ${breaker.failures} failures`)
    breaker.state = 'OPEN'
  }
}

/**
 * Record success in circuit breaker
 */
export function recordCircuitBreakerSuccess(serviceName: string): void {
  const breaker = circuitBreakers.get(serviceName)

  if (breaker) {
    if (breaker.state === 'HALF_OPEN') {
      logger.info('circuit-breaker', `Circuit breaker CLOSED for ${serviceName} after successful request`)
      breaker.state = 'CLOSED'
    }
    breaker.failures = 0
  }
}

/**
 * Utility sleep function
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Get circuit breaker status (for monitoring)
 */
export function getCircuitBreakerStatus(): Record<string, CircuitBreakerState> {
  const status: Record<string, CircuitBreakerState> = {}

  for (const [serviceName, breaker] of circuitBreakers) {
    status[serviceName] = { ...breaker }
  }

  return status
}
