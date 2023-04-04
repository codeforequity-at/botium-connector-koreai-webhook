const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const assert = chai.assert
const MockAdapter = require('axios-mock-adapter')
const _ = require('lodash')

const Connector = require('../../src/connector')
const capsBasic = require('./jsons/mocked_botium_basic.json').botium.Capabilities
const capsWithNlp = require('./jsons/mocked_botium_with_nlp.json').botium.Capabilities
const RICH_ELEMENTS_TEST_DEFINITIONS = require('./jsons/richElements.json')

describe('connector', function () {
  describe('error handling', function () {
    beforeEach(async function () {
      const connector = new Connector({ caps: capsBasic })
      await connector.Validate()
      await connector.Start()
      this.connector = connector
      this.mock = new MockAdapter(Connector.axios)
    })

    it('should throw error on invalid URL', async function () {
      await assert.isRejected(this.connector.UserSays({ messageText: 'hello' }), 'failed to call endpoint "mocked" error message "Request failed with status code 404"')
    })

    it('should handle network error', async function () {
      this.mock.onPost('/mocked').networkError()
      this.mock.onPost('/mocked/findIntent?fetchConfiguredTasks=false').networkError()
      await assert.isRejected(this.connector.UserSays({ messageText: 'hello' }), 'failed to call endpoint "mocked" error message "Network Error"')
    })

    it('should handle timeout', async function () {
      this.mock.onPost('/mocked').timeout()
      this.mock.onPost('/mocked/findIntent?fetchConfiguredTasks=false').timeout()
      await assert.isRejected(this.connector.UserSays({ messageText: 'hello' }), 'failed to call endpoint "mocked" error message "timeout of 0ms exceeded"')
    })
    afterEach(async function () {
      if (this.connector) {
        await this.connector.Stop()
        this.connector = null
        this.mock = null
      }
    })
  })

  describe('rich elements', function () {
    beforeEach(async function () {
      this.botMsgPromise = new Promise(resolve => {
        this.botMsgPromiseResolve = resolve
      })
      const queueBotSays = (botMsg) => {
        this.botMsgPromiseResolve(botMsg)
      }
      const connector = new Connector({
        caps: capsWithNlp,
        queueBotSays
      })
      await connector.Validate()
      await connector.Start()
      this.connector = connector
      this.mock = new MockAdapter(Connector.axios)

      this.mock.onPost('/mocked').reply((config) => {
        try {
          const data = JSON.parse(config.data)
          const desc = RICH_ELEMENTS_TEST_DEFINITIONS.find(({ request }) => request === data.message?.text)
          if (desc) {
            return [200, desc.api]
          }
        } catch (err) {
          return [500, { reason: err }]
        }
        return [404, { reason: 'unknown config' }]
      })
      this.mock.onPost('/mocked/findIntent?fetchConfiguredTasks=false').reply((config) => {
        try {
          const data = JSON.parse(config.data)
          const desc = RICH_ELEMENTS_TEST_DEFINITIONS.find(({ request }) => request === data.input)
          if (desc && desc.nlp) {
            // response.finalResolver.winningIntent[0].intent
            return [200, _.isString(desc.nlp) ? { response: { finalResolver: { winningIntent: [{ intent: desc.nlp }] } } } : desc.nlp]
          }
        } catch (err) {
          return [500, { reason: err }]
        }
        return [500, { reason: 'unknown config' }]
      })
    })

    RICH_ELEMENTS_TEST_DEFINITIONS.forEach(testCase => {
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
        this.mock = null
      }
    })
  })
})
