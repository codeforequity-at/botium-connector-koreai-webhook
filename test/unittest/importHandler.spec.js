const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const assert = chai.assert

const caps = require('./jsons/mocked_botium_for_importer.json').botium.Capabilities
const downloadConverted = require('./jsons/expected_import.json')
const intents = require('../../src/intents')
const { addDownloaderMocks } = require('./helper')

describe('importer', function () {
  beforeEach(async function () {
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
