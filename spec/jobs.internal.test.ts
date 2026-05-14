const configMock = () => ({
  getConfig: () => ({
    jobs: {
      'projects/akkamind-test/locations/local/jobs/retry-job': {
        image: 'retry-job-image',
        maxRetries: 3,
        timeoutSeconds: 30,
      },
      'projects/akkamind-test/locations/local/jobs/no-retry-job': {
        image: 'no-retry-job-image',
        maxRetries: 0,
      },
    },
  }),
})

jest.mock('@utils/config', configMock, { virtual: true })
jest.mock('../src/utils/config', configMock)

describe('jobs config', () => {
  it('maps configured maxRetries to the task template', () => {
    const { jobs } = require('../src/services/jobs/internal')

    const job = jobs.get('projects/akkamind-test/locations/local/jobs/retry-job')

    expect(job?.template?.template?.maxRetries).toBe(3)
  })

  it('keeps zero maxRetries as no retries', () => {
    const { jobs } = require('../src/services/jobs/internal')

    const job = jobs.get('projects/akkamind-test/locations/local/jobs/no-retry-job')

    expect(job?.template?.template?.maxRetries).toBe(0)
  })
})
