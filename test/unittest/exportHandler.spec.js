const _ = require('lodash')
const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const assert = chai.assert
const MockAdapter = require('axios-mock-adapter')

const intents = require('../../src/intents')
const { addDownloaderMocks } = require('./helper')
const nock = require('nock')

const caps = require('./jsons/mocked_botium_for_exporter.json').botium.Capabilities
const toUpload = require('./jsons/utterances_to_export.json')
const expectedExport = require('./jsons/expected_export_api.json')

describe('uploader', function () {
  beforeEach(async function () {
    this.mockAdapter = new MockAdapter(intents.axios)
    addDownloaderMocks(this.mockAdapter)
    this.mockAdapter.onPost('https://bots.kore.ai/api/public/uploadfile')
      .reply((config) => {
        // parsing form data in hacky way, found here:
        // https://github.com/form-data/form-data/issues/433
        // I modified it for buffer support.
        //
        // Other solution would be formdata-node module, because it supports get(),
        // but its not an easy thing because it does not work with commonjs way,
        // using "require", but with import
        // see: https://bobbyhadz.com/blog/javascript-error-err-require-esm-require-of-es-module-not-supported
        // There is a fix or workaround for it, but who knows the sideeffects
        const parseFormData = (form) => form._streams.reduce((result, line) => {
          if (_.isString(line)) {
            const matches = line?.match(/name="([^"]+)"/)
            const key = matches?.[1]
            if (key) {
              result._currentKey = key
            } else if (line !== '\\r\\n') {
              result[result._currentKey] = line
              delete result._currentKey
            }
          } else if (_.isBuffer(line)) {
            if (result._currentKey) {
              result[result._currentKey] = JSON.parse(line.toString())
              delete result._currentKey
            }
          }

          return result
        }, {})
        const result = parseFormData(config.data)
        this.importedFile = result.file
        return [200, {
          fileId: 'mockedFileId'
        }]
      })

    nock('https://bots.kore.ai')
      .post('/api/public/bot/mockedBotId/mlimport')
      .reply(200, (uri, requestBody) => {
        return { _id: 'mockedImportId' }
      })
    const responses = [
      [[200], { status: 'SOMETHING_ELSE_AS_SUCCESS_AND_FAILED' }],
      [[200], { status: 'success' }]
    ]
    this.promiseUploadFinised = new Promise(resolve => {
      this.promiseUploadFinisedResolve = resolve
    })
    this.mockAdapter.onGet('https://bots.kore.ai/api/public/bot/mockedBotId/mlimport/status/mockedImportId')
      .reply(() => {
        const res = responses.shift()
        if (res?.[1].status === 'success') {
          this.promiseUploadFinisedResolve()
        }
        return res
      })
  })

  it('should export the chatbot data', async function () {
    await intents.exportHandler({ caps }, toUpload)
    await this.promiseUploadFinised
    assert.deepEqual(this.importedFile, expectedExport)
  }).timeout(5000)

  afterEach(async function () {
    if (this.connector) {
      await this.connector.Stop()
    }
    this.connector = null
    this.mockAdapter = null
    this.promiseUploadFinised = null
    this.promiseUploadFinisedResolve = null
  })
})
