import Docker, { Container } from 'dockerode'
import { PassThrough } from 'stream'

import { getLogger, Logger } from '@utils/logger'
import pino from 'pino'

export const docker = new Docker()

export const streamContainerLogs = async (
  container: Container,
  logger: pino.Logger = getLogger(Logger.Execution),
  executionName: string
): Promise<void> => {
  const stream = new PassThrough()
  const executionId = executionName.split('/').pop() ?? executionName

  stream.on('data', (chunk) => {
    const raw = chunk.toString('utf8').trim()
    const trimmed = raw.replace(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s+/,
      ''
    )
    if (trimmed) {
      logger.info(`[${executionId}] ${trimmed}`)
    }
  })

  const logs = await container.logs({
    follow: true,
    stderr: true,
    stdout: true,
  })

  logs.on('end', () => stream.end('!stop!'))

  container.modem.demuxStream(logs, stream, stream)

  return
}
