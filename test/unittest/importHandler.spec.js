const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const assert = chai.assert
const MockAdapter = require('axios-mock-adapter')

const caps = require('./jsons/mocked_botium_for_importer.json').botium.Capabilities
const downloadConverted = require('./jsons/expected_import.json')
const intents = require('../../src/intents')
const { addDownloaderMocks } = require('./helper')

describe('downloader', function () {
  beforeEach(async function () {
    this.mockAdapter = new MockAdapter(intents.axios)
    addDownloaderMocks(this.mockAdapter)
  })

  it('should import the chatbot data', async function () {
    const result = await intents.importHandler({ caps })
    assert.deepEqual(result, downloadConverted)
  })

  afterEach(async function () {
    if (this.connector) {
      await this.connector.Stop()
      this.connector = null
      this.mockAdapter = null
    }
  })
})
