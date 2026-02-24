import { protos } from '@google-cloud/run'
import { BadRequest, Conflict, NotFound } from 'http-errors';

import { getConfig } from '@utils/config'
import { Logger, getLogger } from '@utils/logger'
import { executions } from '@services/executions/internal'

const nowTimestamp = () => protos.google.protobuf.Timestamp.create({
  seconds: Math.floor(Date.now() / 1000)
});

const jobsStore = new Map<string, protos.google.cloud.run.v2.Job>();

const configToJob = ([jobName, jobConfig]: [string, ReturnType<typeof getConfig>['jobs'][string]]): protos.google.cloud.run.v2.Job => {
  const timeout = typeof jobConfig.timeoutSeconds === 'number'
    ? protos.google.protobuf.Duration.create({ seconds: jobConfig.timeoutSeconds })
    : undefined

  return protos.google.cloud.run.v2.Job.create({
    name: jobName,
    createTime: nowTimestamp(),
    template: protos.google.cloud.run.v2.ExecutionTemplate.create({
      template: protos.google.cloud.run.v2.TaskTemplate.create({
        containers: [protos.google.cloud.run.v2.Container.create(jobConfig)],
        timeout,
      })
    })
  })
}

Object.entries(getConfig().jobs).forEach(([name, job]) => {
  jobsStore.set(name, configToJob([name, job]));
});

export const jobs = {
  get: (
    name: string,
  ) => {
    const logger = getLogger(Logger.Job);

    logger.debug({ executionName: name }, 'job.get');

    const job = jobsStore.get(name);

    return job ?? null;
  },
  create: (
    job: protos.google.cloud.run.v2.IJob,
  ) => {
    const logger = getLogger(Logger.Job);

    logger.debug({ job }, 'job.create');

    if (!job.name) {
      throw new BadRequest('Invalid Job: name is required');
    }

    if (!job.template?.template?.containers?.length) {
      throw new BadRequest('Invalid Job: template must have at least one container');
    }

    if (jobsStore.has(job.name)) {
      throw new Conflict('Job already exists');
    }

    const storedJob = protos.google.cloud.run.v2.Job.create({
      ...job,
      createTime: nowTimestamp()
    });

    jobsStore.set(job.name, storedJob);

    return storedJob;
  },
  update: (
    job: protos.google.cloud.run.v2.IJob,
  ) => {
    const logger = getLogger(Logger.Job);

    logger.debug({ job }, 'job.update');

    if (!job.name) {
      throw new BadRequest('Invalid Job');
    }

    if (!jobsStore.has(job.name)) {
      throw new NotFound('Unknown Job');
    }

    const storedJob = protos.google.cloud.run.v2.Job.create({
      ...job,
      updateTime: nowTimestamp()
    });

    jobsStore.set(job.name, storedJob);

    return storedJob;
  },
  run: async (name: string, overrides?: protos.google.cloud.run.v2.RunJobRequest.IOverrides) => {
    const logger = getLogger(Logger.Job);

    logger.debug({ jobName: name, overrides }, 'job.run');

    if (!name) {
      throw new BadRequest('Invalid Job');
    }

    const job = jobs.get(name);

    if (!job) {
      throw new NotFound('Unknown Job');
    }

    logger.debug({ ...job, name: name }, `running job ${name}`);

    job.updateTime = nowTimestamp();
    job.executionCount = (job.executionCount ?? 0) + 1;

    const { execution, promise } = await executions.start(job, overrides);

    return { execution, promise };
  }
} as const;
