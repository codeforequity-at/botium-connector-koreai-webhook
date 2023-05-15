require('dotenv').config()
const { exportHandler } = require('../../src/intents')
const { readCaps } = require('./helper')

describe('exporthandler', function () {
  beforeEach(async function () {
    this.caps = readCaps()
  })
  it('should successfully upload existing utterances', async function () {
    await exportHandler({ caps: this.caps, language: 'en' }, {
      utterances: [
        {
          name: 'Ping',
          utterances: ['Ping']
        }
      ]
    })
  }).timeout(10000)
})
