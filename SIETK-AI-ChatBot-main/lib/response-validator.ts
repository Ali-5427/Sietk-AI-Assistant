// Response validation to prevent AI hallucinations and ensure accuracy

import { SIETK_KNOWLEDGE_BASE } from './sietk-knowledge-base'

export interface ValidationResult {
  isValid: boolean
  confidence: number // 0-100
  issues: string[]
}

/**
 * Validate AI response against knowledge base
 * Returns confidence score based on accuracy
 */
export function validateResponse(response: string, originalQuery: string): ValidationResult {
  const issues: string[] = []
  let confidenceScore = 100

  // Check for common hallucination patterns
  const hallucinations = detectHallucinations(response)
  if (hallucinations.length > 0) {
    issues.push(...hallucinations)
    confidenceScore -= 20
  }

  // Check if response contains KB data
  const hasKbContent = containsKbData(response)
  if (!hasKbContent && shouldContainKbData(originalQuery)) {
    issues.push('Response does not reference knowledge base data')
    confidenceScore -= 15
  }

  // Check for suspicious patterns
  const suspicious = detectSuspiciousPatterns(response)
  if (suspicious.length > 0) {
    issues.push(...suspicious)
    confidenceScore -= 10
  }

  // Ensure response is substantive (not just "I don't know")
  if (response.length < 50 && shouldHaveDetailedResponse(originalQuery)) {
    issues.push('Response too short for this query type')
    confidenceScore -= 10
  }

  return {
    isValid: confidenceScore >= 70,
    confidence: Math.max(0, Math.min(100, confidenceScore)),
    issues,
  }
}

/**
 * Detect common hallucination patterns
 */
function detectHallucinations(response: string): string[] {
  const issues: string[] = []
  const lower = response.toLowerCase()

  // Check for made-up numbers that don't match KB
  const numberPatterns = [
    /(?:Rs\.|₹)\s*(\d+(?:,\d+)*)/g,
    /(\d+)%/g,
    /intake[:\s]*(\d+)/gi,
    /fee[:\s]*Rs\.?\s*(\d+(?:,\d+)*)/gi,
  ]

  for (const pattern of numberPatterns) {
    const matches = response.matchAll(pattern)
    for (const match of matches) {
      if (!isValidNumber(match[1])) {
        issues.push(`Potentially made-up number: ${match[0]}`)
      }
    }
  }

  // Check for made-up person names
  if (lower.includes('dr.') || lower.includes('prof.') || lower.includes('mr.') || lower.includes('ms.')) {
    const names = extractNames(response)
    for (const name of names) {
      if (!isValidPerson(name)) {
        issues.push(`Unverified person mentioned: ${name}`)
      }
    }
  }

  return issues
}

/**
 * Detect suspicious patterns that indicate low quality
 */
function detectSuspiciousPatterns(response: string): string[] {
  const issues: string[] = []

  // Too many "I don't know" or "I apologize" = low confidence
  const apologieCount = (response.match(/I apologize|I'm sorry|I cannot/gi) || []).length
  if (apologieCount > 2) {
    issues.push('Multiple apologetic phrases suggest low confidence')
  }

  // Vague language
  if ((response.match(/might be|could be|possibly|perhaps|I think/gi) || []).length > 3) {
    issues.push('Too much speculation instead of definitive answers')
  }

  // Asking user to contact instead of providing info
  if ((response.match(/please contact|please reach out|get in touch/gi) || []).length > 1) {
    issues.push('Primarily directing to contact instead of answering')
  }

  return issues
}

/**
 * Check if response references actual KB data
 */
function containsKbData(response: string): boolean {
  const lower = response.toLowerCase()

  // Check for specific KB content markers
  const kbMarkers = [
    'sietk',
    'naac',
    'placement',
    'department',
    'course',
    'fee',
    'admission',
    '08577',
    'sietk.org',
  ]

  const mentionedMarkers = kbMarkers.filter(marker => lower.includes(marker)).length
  return mentionedMarkers >= 2 // At least 2 KB markers
}

/**
 * Determine if response should contain KB data based on query
 */
function shouldContainKbData(query: string): boolean {
  const lower = query.toLowerCase()
  const kbTopics = ['sietk', 'course', 'fee', 'admission', 'placement', 'department', 'facility', 'contact']
  return kbTopics.some(topic => lower.includes(topic))
}

/**
 * Determine if response should be detailed
 */
function shouldHaveDetailedResponse(query: string): boolean {
  const lower = query.toLowerCase()
  // Don't require length for simple yes/no questions
  const simpleQuestions = ['is', 'does', 'can', 'have', 'are there']
  return !simpleQuestions.some(q => lower.startsWith(q))
}

/**
 * Validate numbers against known KB values
 */
function isValidNumber(num: string): boolean {
  const numInt = parseInt(num.replace(/,/g, ''), 10)

  // Valid ranges based on KB
  const validRanges = [
    { min: 50, max: 1000, desc: 'capacity/intake' },
    { min: 10000, max: 100000, desc: 'fees' },
    { min: 2000, max: 2030, desc: 'year' },
  ]

  return validRanges.some(range => numInt >= range.min && numInt <= range.max)
}

/**
 * Extract person names from response
 */
function extractNames(response: string): string[] {
  const namePattern = /(?:Dr\.|Prof\.|Mr\.|Ms\.)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g
  const names: string[] = []
  let match

  while ((match = namePattern.exec(response))) {
    names.push(match[1])
  }

  return names
}

/**
 * Validate if person exists in KB
 */
function isValidPerson(name: string): boolean {
  const lower = name.toLowerCase()

  // Check against known people in KB
  const knownPeople = [
    'k. ashok raju',
    'c. naga bhaskar',
    'dr. g. prabhakaran',
    'b. rajakumar',
  ]

  return knownPeople.some(person => lower.includes(person.split(' ')[person.split(' ').length - 1]))
}

/**
 * Format response with confidence indicator
 */
export function addConfidenceIndicator(response: string, confidence: number): string {
  if (confidence >= 90) {
    return response + '\n\n✅ **High Confidence** - This information comes directly from SIETK official data.'
  } else if (confidence >= 70) {
    return response + '\n\n⚠️ **Medium Confidence** - This information is based on available SIETK data. For critical decisions, please verify with official sources.'
  } else {
    return response + '\n\n❌ **Low Confidence** - I\'m not certain about this answer. Please contact SIETK directly at 08577-264999.'
  }
}
