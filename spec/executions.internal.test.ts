import { protos } from '@google-cloud/run'

type FakeContainer = {
  wait: jest.Mock
  start: jest.Mock
  inspect: jest.Mock
  kill: jest.Mock
  remove: jest.Mock
}

const createdContainerOptions: unknown[] = []
const fakeContainers: Array<FakeContainer | Promise<FakeContainer>> = []

const dockerMock = () => ({
  docker: {
    createContainer: jest.fn(async (options) => {
      createdContainerOptions.push(options)
      const container = fakeContainers.shift()
      if (!container) {
        throw new Error('No fake container queued')
      }
      return await container
    }),
  },
  streamContainerLogs: jest.fn(async () => undefined),
})

const configMock = () => ({
  getConfig: () => ({ dockerNetwork: undefined }),
})

jest.mock('@utils/docker', dockerMock, { virtual: true })
jest.mock('../src/utils/docker', dockerMock)
jest.mock('@utils/config', configMock, { virtual: true })
jest.mock('../src/utils/config', configMock)

const makeContainer = (statusCode: number): FakeContainer => ({
  wait: jest.fn(async () => ({ StatusCode: statusCode })),
  start: jest.fn(async () => undefined),
  inspect: jest.fn(async () => ({ State: { Running: false } })),
  kill: jest.fn(async () => undefined),
  remove: jest.fn(async () => undefined),
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

const waitForMockCall = async (mock: jest.Mock) => {
  for (let i = 0; i < 10; i += 1) {
    if (mock.mock.calls.length) {
      return
    }
    await Promise.resolve()
  }
}

const makeJob = (maxRetries: number) => protos.google.cloud.run.v2.Job.create({
  name: 'projects/akkamind-test/locations/local/jobs/retry-job',
  template: protos.google.cloud.run.v2.ExecutionTemplate.create({
    template: protos.google.cloud.run.v2.TaskTemplate.create({
      maxRetries,
      containers: [
        protos.google.cloud.run.v2.Container.create({
          image: 'retry-job-image',
          env: [{ name: 'USER_ENV', value: 'user-value' }],
        }),
      ],
    }),
  }),
})

describe('executions retry attempts', () => {
  beforeEach(() => {
    createdContainerOptions.length = 0
    fakeContainers.length = 0
  })

  it('retries failed containers and injects Cloud Run attempt environment', async () => {
    const { executions } = await import('../src/services/executions/internal')
    fakeContainers.push(makeContainer(1), makeContainer(0))

    const { execution, promise } = await executions.start(makeJob(3))
    await promise

    expect(execution.succeededCount).toBe(1)
    expect(execution.failedCount).toBe(0)
    expect(createdContainerOptions).toHaveLength(2)
    expect(createdContainerOptions.map((options: any) => options.Env)).toEqual([
      expect.arrayContaining([
        'USER_ENV=user-value',
        'CLOUD_RUN_JOB=retry-job',
        `CLOUD_RUN_EXECUTION=${execution.name?.split('/').pop()}`,
        'CLOUD_RUN_TASK_INDEX=0',
        'CLOUD_RUN_TASK_ATTEMPT=0',
      ]),
      expect.arrayContaining([
        'USER_ENV=user-value',
        'CLOUD_RUN_JOB=retry-job',
        `CLOUD_RUN_EXECUTION=${execution.name?.split('/').pop()}`,
        'CLOUD_RUN_TASK_INDEX=0',
        'CLOUD_RUN_TASK_ATTEMPT=1',
      ]),
    ])
  })

  it('marks execution failed after retries are exhausted', async () => {
    const { executions } = await import('../src/services/executions/internal')
    fakeContainers.push(makeContainer(1), makeContainer(1), makeContainer(1))

    const { execution, promise } = await executions.start(makeJob(2))
    await promise

    expect(execution.succeededCount).toBe(0)
    expect(execution.failedCount).toBe(1)
    expect(createdContainerOptions).toHaveLength(3)
    expect(createdContainerOptions.map((options: any) => options.Env)).toEqual([
      expect.arrayContaining(['CLOUD_RUN_TASK_ATTEMPT=0']),
      expect.arrayContaining(['CLOUD_RUN_TASK_ATTEMPT=1']),
      expect.arrayContaining(['CLOUD_RUN_TASK_ATTEMPT=2']),
    ])
  })

  it('does not retry after deleting a running execution', async () => {
    const { executions } = await import('../src/services/executions/internal')
    const waitResult = deferred<{ StatusCode: number }>()
    const runningContainer = makeContainer(1)
    runningContainer.wait = jest.fn(() => waitResult.promise)
    runningContainer.inspect = jest.fn(async () => ({ State: { Running: true } }))
    fakeContainers.push(runningContainer, makeContainer(0))

    const { execution, promise } = await executions.start(makeJob(3))
    await waitForMockCall(runningContainer.start)

    await executions.delete(execution.name!)
    waitResult.reject(new Error('container removed'))
    await promise

    expect(execution.deleteTime).toBeDefined()
    expect(createdContainerOptions).toHaveLength(1)
    expect(runningContainer.kill).toHaveBeenCalledTimes(1)
    expect(runningContainer.remove).toHaveBeenCalledTimes(1)
  })

  it('does not start a container created after execution deletion', async () => {
    const { executions } = await import('../src/services/executions/internal')
    const createContainerResult = deferred<FakeContainer>()
    const createdContainer = makeContainer(0)
    fakeContainers.push(createContainerResult.promise, makeContainer(0))

    const { execution, promise } = await executions.start(makeJob(3))
    expect(createdContainerOptions).toHaveLength(1)

    await executions.delete(execution.name!)
    createContainerResult.resolve(createdContainer)
    await promise

    expect(execution.deleteTime).toBeDefined()
    expect(createdContainerOptions).toHaveLength(1)
    expect(createdContainer.start).not.toHaveBeenCalled()
    expect(createdContainer.remove).toHaveBeenCalledTimes(1)
  })
})
