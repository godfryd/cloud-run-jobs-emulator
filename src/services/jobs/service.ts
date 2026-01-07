import { loadPackageDefinition } from '@grpc/grpc-js'
import { protos } from '@google-cloud/run'
import { loadSync } from '@grpc/proto-loader'
import { getProtoPath } from 'google-proto-files'
import { BadRequest, NotFound } from 'http-errors'

import { handler } from '@utils/grpc'
import { Logger, getLogger } from '@utils/logger'
import { jobs } from './internal'

export const jobsServiceDefinitions = loadPackageDefinition(
  loadSync(
    getProtoPath('cloud/run/v2/job.proto'),
    {
      includeDirs: [
        'node_modules/google-proto-files'
      ]
    }
  )
)

export const JobsService = {
  CreateJob: handler<protos.google.cloud.run.v2.ICreateJobRequest, protos.google.longrunning.Operation>(async (call) => {
    const logger = getLogger(Logger.Job);

    logger.debug({ call }, 'CreateJob');

    const job = call.request.job;

    if (!job) {
      throw new BadRequest('Invalid Job: job is required');
    }

    const storedJob = jobs.create(job)

    return protos.google.longrunning.Operation.create({
      name: storedJob.name,
      response: null
    });
  }),
  UpdateJob: handler<protos.google.cloud.run.v2.IUpdateJobRequest, protos.google.longrunning.Operation>(async (call) => {
    const logger = getLogger(Logger.Job);

    logger.debug({ call }, 'UpdateJob');

    const { request: { job, allowMissing, validateOnly } } = call;

    if (!job || !job.name) {
      throw new BadRequest('Invalid Job: name is required');
    }

    const existingJob = jobs.get(job.name);

    if (!existingJob && !allowMissing) {
      throw new NotFound('Unknown Job');
    }
    
    if (validateOnly) {
      const storedJob = protos.google.cloud.run.v2.Job.create(job);
      return protos.google.longrunning.Operation.create({
        name: storedJob.name,
        response: null
      });
    }

    const storedJob = existingJob ? jobs.update(job): jobs.create(job);

    return protos.google.longrunning.Operation.create({
      name: storedJob.name,
      response: null
    });
  }),
  GetJob: handler<protos.google.cloud.run.v2.IGetJobRequest, protos.google.cloud.run.v2.IJob>(async (call) => {
    const logger = getLogger(Logger.Job);

    logger.debug({ call }, 'GetJob');

    const { request: { name: jobName } } = call;

    if (!jobName) {
      throw new BadRequest('Invalid Job: name is required');
    }

    const job = jobs.get(jobName);

    if (!job) {
      throw new NotFound('Unknown Job')
    }
    
    return job;
  }),
  RunJob: handler<protos.google.cloud.run.v2.IRunJobRequest, protos.google.longrunning.Operation>(async (call) => {
    const logger = getLogger(Logger.Job);

    const { name: jobName, overrides } = call.request;
    logger.info({ jobName, overrides }, 'RunJob invoked');

    try {
      if (!jobName) {
        throw new BadRequest('Invalid Job: name is required');
      }

      const { execution } = await jobs.run(jobName, overrides ?? undefined);

      // should contain an Execution?
      return new protos.google.longrunning.Operation({
        name: execution.name,
        response: null
      });
    } catch (err) {
      logger.error(
        { err, jobName, overrides },
        'RunJob failed',
      );
      throw err;
    }
  })
}
