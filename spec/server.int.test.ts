import { Server } from '@grpc/grpc-js'
import { v2 } from '@google-cloud/run'

import { initializeServer, shutdownServer, startServer } from '../src/server'
import { Config, getConfig } from '../src/utils/config'

describe('JobsService', () => {
  let config: Config
  let server: Server | undefined
  let client: v2.JobsClient | undefined

  beforeEach(async () => {
    config = getConfig()
    config.host = 'localhost'
    config.port = 0
    server = initializeServer()
    await startServer(server)

    client = new v2.JobsClient({
      servicePath: config.host,
      port: config.port,
      sslCreds: (new v2.JobsClient() as any)._gaxGrpc.grpc.credentials.createInsecure()
    })
  })

  afterEach(async () => {
    if (server) {
      await shutdownServer(server)
      server = undefined
    }

    if (client) {
      await client.close()
      client = undefined
    }
  })

  describe('RunJob', () => {
    it('throws an error when an non-existent job name is given', async () => {
      delete config.jobs['this-job-does-not-exist']
      await expect(client?.runJob({ name: 'this-job-does-not-exist' })).rejects.toThrow()
    })
  })
})
