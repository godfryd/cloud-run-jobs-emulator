import pino from 'pino'

export enum Logger {
  Job = 'job',
  Execution = 'execution',
  Default = 'default'
}

const levels = new Map<Logger, string>([
  [Logger.Job, 'debug'],
  [Logger.Execution, 'debug'],
  [Logger.Default, 'info'],
])

const loggers = new Map<Logger, pino.Logger>([])

export const getLogger = (name: Logger = Logger.Default, base: { [key: string]: any } = {}): pino.Logger => {
  if (loggers.has(name)) {
    return loggers.get(name)!
  }

  const transportOptions = name === Logger.Execution
    ? { target: 'pino-pretty', options: { ignore: 'time' } }
    : { target: 'pino-pretty' }

  const logger = pino({
    name,
    base,
    level: levels.get(name) ?? 'info',
    transport: {
      target: transportOptions.target,
      options: transportOptions.options
    }
  })

  loggers.set(name, logger)

  return logger
}
