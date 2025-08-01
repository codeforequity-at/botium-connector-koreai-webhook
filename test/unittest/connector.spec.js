const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const assert = chai.assert
const _ = require('lodash')
const nock = require('nock')

const Connector = require('../../src/connector')
const capsBasic = require('./jsons/mocked_botium_basic.json').botium
  .Capabilities
const capsWithNlp = require('./jsons/mocked_botium_with_nlp.json').botium
  .Capabilities
const RICH_ELEMENTS_TEST_DEFINITIONS = require('./jsons/richElements.json')

describe('connector', function () {
  describe('error handling', function () {
    beforeEach(async function () {
      const connector = new Connector({ caps: capsBasic })
      await connector.Validate()
      await connector.Start()
      this.connector = connector
    })

    it('should throw error on invalid URL', async function () {
      await assert.isRejected(
        this.connector.UserSays({ messageText: 'hello' }),
        'failed to call endpoint "http://mocked" error message "fetch failed"'
      )
    })

    it('should handle network error', async function () {
      nock('http://mocked').post('/').replyWithError('Network Error')

      nock('http://mocked')
        .post('/findIntent?fetchConfiguredTasks=false')
        .replyWithError('Network Error')
      await assert.isRejected(
        this.connector.UserSays({ messageText: 'hello' }),
        'failed to call endpoint "http://mocked" error message "Network Error"'
      )
    })

    it('should handle timeout', async function () {
      nock('http://mocked')
        .post('/')
        .delay(3000) // Delay greater than fetch timeout
        .reply(200, { message: 'should never be received' })

      nock('http://mocked')
        .post('/findIntent?fetchConfiguredTasks=false')
        .delay(3000) // Delay greater than fetch timeout
        .reply(200, { message: 'should never be received' })

      await assert.isRejected(
        this.connector.UserSays({ messageText: 'hello' }, 1000),
        'failed to call endpoint "http://mocked" error message "This operation was aborted"'
      )
    })
    afterEach(async function () {
      if (this.connector) {
        await this.connector.Stop()
        this.connector = null
        this.mock = null
      }
      nock.cleanAll()
    })
  })

  describe('rich elements', function () {
    beforeEach(async function () {
      this.botMsgPromise = new Promise((resolve) => {
        this.botMsgPromiseResolve = resolve
      })
      const queueBotSays = (botMsg) => {
        this.botMsgPromiseResolve(botMsg)
      }
      const connector = new Connector({
        caps: capsWithNlp,
        queueBotSays,
      })
      await connector.Validate()
      await connector.Start()
      this.connector = connector
      nock('http://mocked')
        .post('/')
        .reply(200, (uri, requestBody) => {
          try {
            const data = requestBody
            const desc = RICH_ELEMENTS_TEST_DEFINITIONS.find(
              ({ request }) => request === data.message?.text
            )
            if (desc) {
              return desc.api
            }
          } catch (err) {
            return { reason: err.message }
          }
          return { reason: 'unknown config' }
        })
        .persist()
      nock('http://mocked')
        .post('/findIntent?fetchConfiguredTasks=false')
        .reply(200, (uri, requestBody) => {
          try {
            const data = requestBody
            const desc = RICH_ELEMENTS_TEST_DEFINITIONS.find(
              ({ request }) => request === data.input
            )
            if (desc && desc.nlp) {
              // response.finalResolver.winningIntent[0].intent
              return _.isString(desc.nlp)
                ? {
                  response: {
                    finalResolver: {
                      winningIntent: [{ intent: desc.nlp }],
                    },
                  },
                }
                : desc.nlp
            }
          } catch (err) {
            return { reason: err.message }
          }
          return { reason: 'unknown config' }
        })
        .persist()
    })

    RICH_ELEMENTS_TEST_DEFINITIONS.forEach((testCase) => {
      it(`should handle ${testCase.request}`, async function () {
        await this.connector.UserSays({ messageText: testCase.request })
        const botMsg = await this.botMsgPromise
        assert.deepEqual(botMsg, testCase.chatbot)
      })
    })

    afterEach(async function () {
      if (this.connector) {
        await this.connector.Stop()
        this.connector = null
      }
      nock.cleanAll() // Clean up all nock interceptors
    })
  })
})
