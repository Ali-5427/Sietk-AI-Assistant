// Structured logging utility for production monitoring

export interface LogEntry {
  timestamp: string
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'
  component: string
  message: string
  duration?: number
  status?: number
  error?: string
  metadata?: Record<string, unknown>
}

class Logger {
  private isDevelopment = process.env.NODE_ENV === 'development'

  log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', component: string, message: string, metadata?: Record<string, unknown>) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      metadata,
    }

    // Always log to console in development
    if (this.isDevelopment) {
      const color = {
        INFO: '\x1b[36m',
        WARN: '\x1b[33m',
        ERROR: '\x1b[31m',
        DEBUG: '\x1b[35m',
      }[level]
      const reset = '\x1b[0m'
      console.log(`${color}[${level}]${reset} [${component}] ${message}`, metadata || '')
    } else {
      // In production, log as JSON for structured logging (CloudWatch, LogRocket, etc)
      console.log(JSON.stringify(entry))
    }

    // Send critical errors to monitoring service (optional)
    if (level === 'ERROR' && !this.isDevelopment) {
      this.reportError(entry)
    }
  }

  info(component: string, message: string, metadata?: Record<string, unknown>) {
    this.log('INFO', component, message, metadata)
  }

  warn(component: string, message: string, metadata?: Record<string, unknown>) {
    this.log('WARN', component, message, metadata)
  }

  error(component: string, message: string, error?: Error, metadata?: Record<string, unknown>) {
    this.log('ERROR', component, message, {
      errorName: error?.name,
      errorMessage: error?.message,
      errorStack: error?.stack,
      ...metadata,
    })
  }

  debug(component: string, message: string, metadata?: Record<string, unknown>) {
    if (this.isDevelopment) {
      this.log('DEBUG', component, message, metadata)
    }
  }

  // Report critical errors to monitoring service
  private reportError(entry: LogEntry) {
    // TODO: Integrate with Sentry, LogRocket, or other error tracking service
    // Example: Sentry.captureException(entry)
    try {
      // Placeholder for error reporting
      // fetch('/api/error-report', { method: 'POST', body: JSON.stringify(entry) })
    } catch {
      // Silently fail to not interrupt app
    }
  }
}

export const logger = new Logger()
