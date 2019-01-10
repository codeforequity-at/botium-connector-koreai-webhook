const util = require('util')
const request = require('request')
const uuidv4 = require('uuid/v4')
const jwt = require('jsonwebtoken')
const _ = require('lodash')
const debug = require('debug')('botium-connector-koreai-webhook')

const Capabilities = {
  KOREAI_WEBHOOK_URL: 'KOREAI_WEBHOOK_URL',
  KOREAI_WEBHOOK_CLIENTID: 'KOREAI_WEBHOOK_CLIENTID',
  KOREAI_WEBHOOK_CLIENTSECRET: 'KOREAI_WEBHOOK_CLIENTSECRET',
  KOREAI_WEBHOOK_FROMID: 'KOREAI_WEBHOOK_FROMID',
  KOREAI_WEBHOOK_TOID: 'KOREAI_WEBHOOK_TOID'
}

class BotiumConnectorKoreaiWebhook {
  constructor ({ queueBotSays, caps }) {
    this.queueBotSays = queueBotSays
    this.caps = caps
    this.token = null
    this.fromId = null
    this.toId = null
  }

  Validate () {
    debug('Validate called')

    if (!this.caps[Capabilities.KOREAI_WEBHOOK_URL]) throw new Error('KOREAI_WEBHOOK_URL capability required')
    if (!this.caps[Capabilities.KOREAI_WEBHOOK_CLIENTID]) throw new Error('KOREAI_WEBHOOK_CLIENTID capability required')
    if (!this.caps[Capabilities.KOREAI_WEBHOOK_CLIENTSECRET]) throw new Error('KOREAI_WEBHOOK_CLIENTSECRET capability required')

    return Promise.resolve()
  }

  Start () {
    debug('Start called')

    if (this.caps[Capabilities.KOREAI_WEBHOOK_FROMID]) {
      this.fromId = this.caps[Capabilities.KOREAI_WEBHOOK_FROMID]
    } else {
      this.fromId = uuidv4()
    }
    if (this.caps[Capabilities.KOREAI_WEBHOOK_TOID]) {
      this.toId = this.caps[Capabilities.KOREAI_WEBHOOK_TOID]
    } else {
      this.toId = uuidv4()
    }
    const tokenPayload = {
      isAnonymous: true
    }
    const tokenOptions = {
      algorithm: 'HS256',
      expiresIn: '1d',
      issuer: this.caps[Capabilities.KOREAI_WEBHOOK_CLIENTID],
      audience: 'https://idproxy.kore.ai/authorize',
      subject: this.fromId
    }

    this.token = jwt.sign(tokenPayload, this.caps[Capabilities.KOREAI_WEBHOOK_CLIENTSECRET], tokenOptions)
    debug(`Generated token ${this.token} from payload "${util.inspect(tokenPayload)}", options "${util.inspect(tokenOptions)}"`)
  }

  UserSays (msg) {
    debug(`UserSays called ${util.inspect(msg)}`)
    return this._doRequest(msg)
  }

  Stop () {
    debug('Stop called')
    this.token = null
    this.fromId = null
    this.toId = null
  }

  _doRequest (msg) {
    return new Promise((resolve, reject) => {
      const requestOptions = this._buildRequest(msg)
      debug(`constructed requestOptions ${JSON.stringify(requestOptions, null, 2)}`)

      request(requestOptions, (err, response, body) => {
        if (err) {
          reject(new Error(`rest request failed: ${util.inspect(err)}`))
        } else {
          if (response.statusCode >= 400) {
            debug(`got error response: ${response.statusCode}/${response.statusMessage}`)
            return reject(new Error(`got error response: ${response.statusCode}/${response.statusMessage}`))
          }
          resolve(this)

          if (body) {
            debug(`got response body: ${JSON.stringify(body, null, 2)}`)

            if (body.text) {
              const messageTexts = (_.isArray(body.text) ? body.text : [ body.text ])
              messageTexts.filter(t => t).forEach((messageText) => {
                const botMsg = { sourceData: body, messageText }
                setTimeout(() => this.queueBotSays(botMsg), 0)
              })
            }
          }
        }
      })
    })
  }

  _buildRequest (msg) {
    const uri = this.caps[Capabilities.KOREAI_WEBHOOK_URL]

    const requestOptions = {
      uri,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`
      },
      json: true,
      body: {
        message: {
          text: msg.messageText
        },
        from: {
          id: this.fromId
        },
        to: {
          id: this.toId
        }
      }
    }
    return requestOptions
  }
}

module.exports = BotiumConnectorKoreaiWebhook
