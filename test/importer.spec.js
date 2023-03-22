const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const assert = chai.assert
const MockAdapter = require('axios-mock-adapter')

const caps = require('./mocked_botium_for_importer.json').botium.Capabilities
const downloadConverted = require('./expected_import.json')
const intents = require('../src/intents')
const { addDownloaderMocks } = require('./helper')

describe('downloader', function () {
  beforeEach(async function () {
    this.mockAdapter = new MockAdapter(intents.axios)
    addDownloaderMocks(this.mockAdapter)
  })

  it('should download the chatbot data', async function () {
    await assert.becomes(intents.importHandler({ caps }), downloadConverted)
  })

  afterEach(async function () {
    if (this.connector) {
      await this.connector.Stop()
      this.connector = null
      this.mockAdapter = null
    }
  })
})
