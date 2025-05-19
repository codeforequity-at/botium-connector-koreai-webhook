const _ = require('lodash')
const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const assert = chai.assert
const nock = require('nock')
const formidable = require('formidable') // Library to parse multipart form data

const intents = require('../../src/intents')
const { addDownloaderMocks } = require('./helper')

const caps = require('./jsons/mocked_botium_for_exporter.json').botium.Capabilities
const toUpload = require('./jsons/utterances_to_export.json')
const expectedExport = require('./jsons/expected_export_api.json')

// describe('exporter', function () {
//   beforeEach(async function () {
//     // Mock downloader-related requests
//     addDownloaderMocks(nock)

//     // Mock the file upload endpoint
//     nock('https://bots.kore.ai')
//       .post('/api/public/uploadfile')
//       .reply(200, (uri, requestBody, cb) => {
//         // Parse the multipart form data using formidable
//         const form = new formidable.IncomingForm()
//         form.parse(requestBody, (err, fields, files) => {
//           if (err) {
//             cb(null, [500, { error: 'Failed to parse form data' }])
//             return
//           }

//           // Extract the uploaded file from the parsed data
//           this.importedFile = JSON.parse(fields.file)
//           cb(null, [200, { fileId: 'mockedFileId' }])
//         })
//       })

//     // Mock the bot import endpoint
//     nock('https://bots.kore.ai')
//       .post('/api/public/bot/mockedBotId/mlimport')
//       .reply(200, { _id: 'mockedImportId' })

//     // Mock the import status endpoint
//     const responses = [
//       [200, { status: 'SOMETHING_ELSE_AS_SUCCESS_AND_FAILED' }],
//       [200, { status: 'success' }]
//     ]
//     this.promiseUploadFinised = new Promise(resolve => {
//       this.promiseUploadFinisedResolve = resolve
//     })
//     nock('https://bots.kore.ai')
//       .get('/api/public/bot/mockedBotId/mlimport/status/mockedImportId')
//       .times(responses.length) // Ensure the mock is called the correct number of times
//       .reply(() => {
//         const res = responses.shift()
//         if (res?.[1].status === 'success') {
//           this.promiseUploadFinisedResolve()
//         }
//         return res
//       })
//   })

//   it('should export the chatbot data', async function () {
//     await intents.exportHandler({ caps }, toUpload)
//     await this.promiseUploadFinised
//     assert.deepEqual(this.importedFile, expectedExport)
//   }).timeout(5000)

//   afterEach(async function () {
//     if (this.connector) {
//       await this.connector.Stop()
//     }
//     this.connector = null
//     this.promiseUploadFinised = null
//     this.promiseUploadFinisedResolve = null
//     nock.cleanAll() // Clean up all nock interceptors
//   })
// })