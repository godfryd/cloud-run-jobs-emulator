import { loadPackageDefinition } from '@grpc/grpc-js'
import { protos } from '@google-cloud/run'
import { loadSync } from '@grpc/proto-loader'
import { getProtoPath } from 'google-proto-files'
import { BadRequest, NotFound } from 'http-errors'

import { handler } from '@utils/grpc'
import { Logger, getLogger } from '@utils/logger'
import { executions } from './internal'

export const executionsServiceDefinitions = loadPackageDefinition(
  loadSync(
    getProtoPath('cloud/run/v2/execution.proto'),
    {
      includeDirs: [
        'node_modules/google-proto-files'
      ]
    }
  )
);

export const ExecutionsService = {
  ListExecutions: handler<protos.google.cloud.run.v2.IListExecutionsRequest, protos.google.cloud.run.v2.IListExecutionsResponse>(async (call) => {
    const logger = getLogger(Logger.Execution);

    logger.debug({ call }, 'ListExecutions');

    const jobName = call.request.parent;

    if (!jobName) {
      throw new BadRequest('Invalid Job Name');
    }

    return {
      executions: executions.list(jobName),
    };
  }),
  CancelExecution: handler<protos.google.cloud.run.v2.ICancelExecutionRequest, protos.google.longrunning.Operation>(async (call) => {
    const logger = getLogger(Logger.Job);

    logger.debug({ call }, 'CancelExecution');

    const executionName = call.request.name;

    if (!executionName) {
      throw new BadRequest('Invalid Execution: name is required');
    }

    const execution = executions.get(executionName);

    if (!execution) {
      throw new NotFound('Unknown Execution')
    }

    await executions.cancel(executionName);

    return protos.google.longrunning.Operation.create({
      name: executionName,
      done: true,
      response: protos.google.cloud.run.v2.Execution.toObject(execution)
    });
  }),
  DeleteExecution: handler<protos.google.cloud.run.v2.IDeleteExecutionRequest, protos.google.longrunning.Operation>(async (call) => {
    const logger = getLogger(Logger.Job);

    logger.debug({ call }, 'DeleteExecution');

    const executionName = call.request.name;

    if (!executionName) {
      throw new BadRequest('Invalid Execution: name is required');
    }

    const execution = executions.get(executionName);

    if (!execution) {
      throw new NotFound('Unknown Execution')
    }

    await executions.delete(executionName);

    return protos.google.longrunning.Operation.create({
      name: executionName,
      done: true
    });
  }),
  GetExecution: handler<protos.google.cloud.run.v2.IGetExecutionRequest, protos.google.cloud.run.v2.IExecution>(async (call) => {
    const logger = getLogger(Logger.Job);

    logger.debug({ call }, 'GetExecution');

    const executionName = call.request.name;

    if (!executionName) {
      throw new BadRequest('Invalid Execution: name is required');
    }

    const execution = executions.get(executionName);

    if (!execution) {
      throw new NotFound('Unknown Execution')
    }
    
    return execution;
  }),
}
