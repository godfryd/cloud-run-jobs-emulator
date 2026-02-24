import fs from 'fs'
import YAML from 'yaml'
import yargsParser from 'yargs-parser'
import { getLogger } from './logger'

let config: Config

export class Config {
  host: string = process.env?.HOST ?? '0.0.0.0'
  port: number = parseInt(process.env?.PORT ?? '8123')

  jobs: {
    [name: string]: {
      image: string;
      command?: string[];
      env?: {
        name: string;
        value: string;
      }[];
      timeoutSeconds?: number | string;
    }
  } = {}

  applicationDefaultCredentials?: string;
  dockerNetwork: string | undefined = process.env?.DOCKER_NETWORK;

  private resolveEnvValue (value: string): string {
    const match = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?}$/)

    if (!match) {
      return value
    }

    const envName = match[1]
    const defaultValue = match[3] ?? ''
    return process.env?.[envName] ?? defaultValue
  }

  private resolveTimeoutSeconds (rawValue: number | string | undefined): number | undefined {
    if (rawValue === undefined) {
      return undefined
    }

    const resolvedValue = typeof rawValue === 'string' ? this.resolveEnvValue(rawValue).trim() : rawValue

    if (resolvedValue === '') {
      return undefined
    }

    const timeoutSeconds = Number.parseInt(resolvedValue.toString(), 10)

    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      return undefined
    }

    return timeoutSeconds
  }

  private resolveJobConfigValues (): void {
    const logger = getLogger()

    Object.entries(this.jobs).forEach(([jobName, job]) => {
      if (!job?.env?.length) {
        // Resolve timeout even when job has no env entries.
        const timeoutSeconds = this.resolveTimeoutSeconds(job.timeoutSeconds)

        if (job.timeoutSeconds !== undefined && timeoutSeconds === undefined) {
          logger.warn({ jobName, timeoutSeconds: job.timeoutSeconds }, 'invalid job timeoutSeconds value')
        }

        job.timeoutSeconds = timeoutSeconds
        return
      }

      job.env = job.env.map((entry) => ({
        ...entry,
        value: this.resolveEnvValue(entry.value)
      }))

      // Resolve and validate optional per-job execution timeout.
      const timeoutSeconds = this.resolveTimeoutSeconds(job.timeoutSeconds)
      if (job.timeoutSeconds !== undefined && timeoutSeconds === undefined) {
        logger.warn({ jobName, timeoutSeconds: job.timeoutSeconds }, 'invalid job timeoutSeconds value')
      }
      job.timeoutSeconds = timeoutSeconds
    })
  }

  constructor () {
    const logger = getLogger()
    const argv = yargsParser(process.argv?.slice(2))

    if (argv?.config) {
      logger.info({ path: argv.config }, `loading config from ${argv.config}`)

      try {
        if (!fs.existsSync(argv.config)) {
          throw new Error(`invalid config provided, ${argv.config} does not exist`)
        }

        Object.assign(this, YAML.parse(fs.readFileSync(argv.config, 'utf8')) ?? {})
        this.resolveJobConfigValues()
      } catch (err) {
        logger.error({ err }, 'failed to load jobs config')
      }
    }
  }
}

export const getConfig = (): Config => {
  if (!config) {
    config = new Config()
  }

  return config
}
