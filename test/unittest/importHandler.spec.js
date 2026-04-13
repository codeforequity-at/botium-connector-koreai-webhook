import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'

import { addDownloaderMocks } from './helper.js'

chai.use(chaiAsPromised)

describe('importer', function () {
  beforeEach(async function () {
    addDownloaderMocks(this.mockAdapter)
  })

  // it('should import the chatbot data', async function () {
  //   const result = await intents.importHandler({ caps })
  //   assert.deepEqual(result, downloadConverted)
  // })

  afterEach(async function () {
    if (this.connector) {
      await this.connector.Stop()
      this.connector = null
      this.mockAdapter = null
    }
  })
})
