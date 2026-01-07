import path from 'path';
import { protos } from '@google-cloud/run'
import { NotFound, BadRequest, InternalServerError, RequestTimeout } from 'http-errors';

import { docker, streamContainerLogs } from '@utils/docker'
import { Logger, getLogger } from '@utils/logger'
import Dockerode from 'dockerode'
import { getConfig } from '@utils/config';

const expandEnvVars = (input?: string | null) => {
  const raw = input ?? '';

  return raw.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/g, (_match, braced, bare) => {
    const key = (braced ?? bare) as string | undefined;
    if (!key) {
      return '';
    }
    return process.env[key] ?? '';
  });
};

const nowTimestamp = () => protos.google.protobuf.Timestamp.create({
  seconds: Math.floor(Date.now() / 1000)
});

const executionNamesByJobName = new Map<string, string[]>();
const executionsStore = new Map<string, protos.google.cloud.run.v2.Execution>();
const runningContainersByExecutionName = new Map<string, Dockerode.Container>();

export const executions = {
  list: (jobName: string | '-' = '-') => {
    const logger = getLogger(Logger.Execution);

    logger.debug({ jobName }, 'execution.list');

    if (jobName === '-') {
      return Array.from(executionsStore.values());
    }

    return executionNamesByJobName.get(jobName)?.map(name => executionsStore.get(name)).filter(
      (execution): execution is protos.google.cloud.run.v2.Execution => !!execution
    ) ?? [];
  },
  override: (job: protos.google.cloud.run.v2.IJob, overrides?: protos.google.cloud.run.v2.RunJobRequest.IOverrides) => {
    const logger = getLogger(Logger.Execution);

    logger.debug({ job, overrides }, 'execution.override');

    if (!overrides) {
      return job;
    }

    if (!job.template?.template?.containers?.length) {
      throw new BadRequest('Invalid Job: template must have at least one container');
    }

    const applyContainerOverrides = (containerOverrides: protos.google.cloud.run.v2.RunJobRequest.Overrides.IContainerOverride[]): protos.google.cloud.run.v2.IJob => {
      const clonedJob = JSON.parse(JSON.stringify(job)) as protos.google.cloud.run.v2.IJob;
      const overriddenJob = protos.google.cloud.run.v2.Job.create(clonedJob);

      if (!containerOverrides.length) {
        return overriddenJob;
      }

      if (containerOverrides.length > (overriddenJob.template?.template?.containers?.length ?? 0)) {
        throw new BadRequest('Invalid Job: too many container overrides');
      }

      // https://cloud.google.com/php/docs/reference/cloud-run/latest/V2.RunJobRequest.Overrides.ContainerOverride
      containerOverrides.forEach(({ name, args, env, clearArgs }, i) => {
        const container = overriddenJob.template?.template?.containers?.[i];

        if (!container) {
          throw new BadRequest('Invalid Job: container override without container');
        }

        if (name) {
          container.image = name;
        }

        if (args) {
          container.args = args;
        }

        if (clearArgs) {
          container.args = null;
        }

        if (env) {
          container.env = Object.entries([
            ...(container.env ?? []),
            ...env
          ].reduce(
            (acc, { name, value }) => {
              if (!name || !value) {
                logger.warn({ envVar: name, value }, 'invalid env var');
                return acc;
              }
              
              acc[name] = value;
              return acc;
            },
            {} as Record<string, string>
          )).map(([name, value]) => ({ name, value }));
        }
      });

      return overriddenJob;
    }

    const overriddenJob = applyContainerOverrides(overrides?.containerOverrides ?? []);

    if (overrides?.taskCount && overrides.taskCount > 1) {
      logger.warn({ taskCount: overrides.taskCount }, 'taskCount is not yet supported, running only one task');
    }

    if (overrides?.timeout) {
      const { timeout: { seconds, nanos } } = overrides;

      const secondsNumber = Number.parseInt((seconds ?? 0).toString());
      const nanosNumber = Number.parseInt((nanos ?? 0).toString());

      if (secondsNumber < 0 || secondsNumber > 24 * 60 * 60) {
        throw new BadRequest('Invalid Job: timeout must be between 0 and 24 hours');
      }

      if (nanosNumber < 0 || nanosNumber > 999_999_999) {
        throw new BadRequest('Invalid Job: timeout nanos must be between 0 and 999,999,999');
      }

      if (!overriddenJob.template?.template) {
        throw new BadRequest('Invalid Job: template is required');
      }

      overriddenJob.template.template.timeout = protos.google.protobuf.Duration.create({
        seconds,
        nanos
      });
    }

    return overriddenJob;
  },
  start: async (job: protos.google.cloud.run.v2.IJob, overrides?: protos.google.cloud.run.v2.RunJobRequest.IOverrides) => {
    const logger = getLogger(Logger.Execution);

    logger.debug({ job, overrides }, 'execution.create');

    if (!job.name) {
      throw new BadRequest('Invalid Job for Execution: name is required');
    }

    if (overrides?.taskCount && overrides.taskCount > 1) {
      logger.warn({ taskCount: overrides.taskCount }, 'taskCount is not yet supported, running only one task');
    }

    if (!job.template?.template?.containers?.[0]?.image) {
      throw new BadRequest('Invalid Job: template must have at least one container with an image');
    }

    const overriddenJob = executions.override(job, overrides ?? {});

    // todo: add support for multiple containers
    const [containerTemplate] = overriddenJob.template?.template?.containers ?? [];

    const options: Dockerode.ContainerCreateOptions = {
      Image: containerTemplate?.image ?? undefined,
      Entrypoint: containerTemplate?.command ?? undefined,
      Cmd: containerTemplate?.args ?? undefined,
      Env: containerTemplate.env?.map(({ name, value }) => `${name}=${expandEnvVars(value)}`) ?? [],
      ...(containerTemplate?.ports ? { 
        ExposedPorts: Object.fromEntries(
          containerTemplate?.ports
            ?.filter((port): port is typeof port & { containerPort: number } => !!port.containerPort)
            .map(({ containerPort }) => [`${containerPort}/tcp`, {}])
        ),
        HostConfig: {
          PortBindings: Object.fromEntries(
            containerTemplate?.ports
              ?.filter((port): port is typeof port & { containerPort: number } => !!port.containerPort)
              .map(({ containerPort }) => [
                `${containerPort}/tcp`, 
                [{ HostPort: containerPort.toString() }]
              ])
          )
        }
      } : {}),
    };

    const config = getConfig();
    if (config.dockerNetwork) {
      options.HostConfig = {
        ...(options.HostConfig ?? {}),
        NetworkMode: config.dockerNetwork,
      };
    }

    // If the job is configured to use GCP application default credentials, bind the host's GCP credentials directory to the container
    // so that the container can authenticate with GCP services. Should be used in conjunction with GOOGLE_APPLICATION_CREDENTIALS env var
    if (config.applicationDefaultCredentials) {
      let gcpDirectory = config.applicationDefaultCredentials;

      const pathParts = gcpDirectory.split(path.sep);

      if (pathParts.includes('$HOST_HOME')) {
        if (!process.env.HOST_HOME) {
          throw new InternalServerError('HOST_HOME not set');
        }
        
        gcpDirectory = pathParts.map(part => part === '$HOST_HOME' ? process.env.HOST_HOME : part).join(path.sep);
      }

      options.HostConfig = {
        ...(options.HostConfig ?? {}),
        Binds: [`${gcpDirectory}:/gcp/config:ro`],
      }
    }

    const execution = protos.google.cloud.run.v2.Execution.create({
      name: `${job.name}/executions/${Date.now()}`,
      template: job.template?.template,
      createTime: nowTimestamp(),
      updateTime: nowTimestamp(),
    });

    executionsStore.set(execution.name, execution);
    executionNamesByJobName.set(job.name, [...(executionNamesByJobName.get(job.name) ?? []), execution.name]);
    
    logger.debug({ options }, `creating container for execution ${execution.name}`);
    const container = await docker.createContainer(options);
    runningContainersByExecutionName.set(execution.name, container);

    const startExecution = async () => {
      const waitForCompletion = async () => {
        const { StatusCode } = await container.wait();
    
        if (StatusCode !== 0) {
          throw new InternalServerError(`failed to run execution ${execution.name} for job ${job.name}, container exited with status ${StatusCode}`);
        }
      };

      try {
        let timeoutTimer: NodeJS.Timeout;

        execution.startTime = nowTimestamp();
        execution.updateTime = nowTimestamp();
        execution.runningCount = 1;

        const timeoutMs = (() => {
          const timeout = overriddenJob.template?.template?.timeout;

          if (!timeout) {
            return 1_800_000;
          }

          return Number.parseInt((timeout.seconds ?? 0).toString()) * 1000 + Number.parseInt((timeout.nanos ?? 0).toString()) / 1_000_000;
        })();

        const expiration = new Promise((_, reject) => {
          timeoutTimer = setTimeout(() => {
            execution.expireTime = nowTimestamp();
            execution.updateTime = nowTimestamp();

            reject(new RequestTimeout(`job ${execution.name} timed out after ${timeoutMs.toFixed(6)}ms`));
          }, timeoutMs);
        });

        await container.start();
        await streamContainerLogs(container, logger, execution.name);

        await Promise.race([
          waitForCompletion()
            .then(() => {
              execution.succeededCount = 1;
              execution.updateTime = nowTimestamp();
            })
            .finally(() => clearTimeout(timeoutTimer)),
          expiration
        ]);

        logger.debug(`execution ${execution.name} for job ${job.name} completed successfully`);

      } catch (err) {
        execution.failedCount = 1;
        execution.updateTime = nowTimestamp();
        logger.error({ err }, `execution ${execution.name} for job ${job.name} failed`);
      } finally {
        execution.runningCount = 0;
        execution.completionTime = nowTimestamp();
        execution.updateTime = nowTimestamp();
      
        const runningContainer = runningContainersByExecutionName.get(execution.name);

        if (runningContainer && (await runningContainer.inspect()).State.Running) {
          await runningContainer.kill();
          await runningContainer.remove();
          runningContainersByExecutionName.delete(execution.name);
        }
      }
    };

    const promise = startExecution();

    return { execution, promise };
  },
  delete: async (name: string) => {
    const logger = getLogger(Logger.Execution);

    logger.debug({ executionName: name }, 'execution.delete');

    const execution = executionsStore.get(name);

    if (!execution) {
      throw new NotFound('Unknown Execution')
    }

    execution.deleteTime = nowTimestamp();

    if (execution.runningCount || (execution.startTime && !execution.completionTime)) {
      const container = runningContainersByExecutionName.get(name);

      if (container) {
        logger.debug({ executionName: name }, `killing running container for execution ${name}`);
        await container.kill();
        await container.remove();
        runningContainersByExecutionName.delete(name);
      }
    }
  },
  cancel: async (name: string) => {
    const logger = getLogger(Logger.Execution);

    logger.debug({ executionName: name }, 'execution.cancel');

    const execution = executionsStore.get(name);

    if (!execution) {
      throw new NotFound('Unknown Execution')
    }

    if (execution.completionTime) {
      return;
    }

    if (execution.runningCount || (execution.startTime && !execution.completionTime)) {
      const container = runningContainersByExecutionName.get(name);

      if (container) {
        logger.debug({ executionName: name }, `killing running container for execution ${name}`);
        await container.kill();
        await container.remove();
        runningContainersByExecutionName.delete(name);
      }
    }

    execution.runningCount = 0;
    execution.failedCount = Math.max(execution.failedCount ?? 0, 1);
    execution.completionTime = nowTimestamp();
    execution.updateTime = nowTimestamp();
  },
  get: (name: string) => {
    const logger = getLogger(Logger.Execution);

    logger.debug({ executionName: name }, 'execution.get');

    const execution = executionsStore.get(name);

    if (!execution) {
      throw new NotFound('Unknown Execution')
    }
    
    return execution;
  },
}
