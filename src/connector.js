const util = require('util')
const request = require('request-promise-native')
const { v4: uuidv4 } = require('uuid')
const jwt = require('jsonwebtoken')
const _ = require('lodash')
const debug = require('debug')('botium-connector-koreai-webhook')

const Capabilities = require('./Capabilities')

class BotiumConnectorKoreaiWebhook {
  constructor ({ queueBotSays, caps }) {
    this.queueBotSays = queueBotSays
    this.caps = caps
    this.token = null
    this.adminToken = null
    this.fromId = null
    this.toId = null
    this.nlpAnalyticsUri = null
  }

  Validate () {
    debug('Validate called')

    if (!this.caps[Capabilities.KOREAI_WEBHOOK_URL]) throw new Error('KOREAI_WEBHOOK_URL capability required')
    if (!this.caps[Capabilities.KOREAI_WEBHOOK_CLIENTID]) throw new Error('KOREAI_WEBHOOK_CLIENTID capability required')
    if (!this.caps[Capabilities.KOREAI_WEBHOOK_CLIENTSECRET]) throw new Error('KOREAI_WEBHOOK_CLIENTSECRET capability required')
    if (this.caps[Capabilities.KOREAI_WEBHOOK_NLP_ANALYTICS_ENABLE] && !this.caps[Capabilities.KOREAI_WEBHOOK_BOTNAME]) throw new Error('KOREAI_WEBHOOK_BOTNAME capability required for NLP Analytics')

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
    this.token = this.createToken()
    this.adminToken = this.createAdminToken()
    if (this.caps[Capabilities.KOREAI_WEBHOOK_NLP_ANALYTICS_ENABLE]) {
      if (this.caps[Capabilities.KOREAI_WEBHOOK_NLP_ANALYTICS_URL]) {
        this.nlpAnalyticsUri = this.caps[Capabilities.KOREAI_WEBHOOK_NLP_ANALYTICS_URL]
      } else if (!this.caps[Capabilities.KOREAI_WEBHOOK_URL].indexOf('/chatbot/hooks/') > 0) {
        debug(`Webhook URL ${this.caps[Capabilities.KOREAI_WEBHOOK_URL]} is not valid, NLP analytics disabled`)
      } else {
        const normalizedUri = this.caps[Capabilities.KOREAI_WEBHOOK_URL].indexOf('/hookInstance/') > 0
          ? this.caps[Capabilities.KOREAI_WEBHOOK_URL].substring(0, this.caps[Capabilities.KOREAI_WEBHOOK_URL].indexOf('/hookInstance/'))
          : this.caps[Capabilities.KOREAI_WEBHOOK_URL]
        this.nlpAnalyticsUri = normalizedUri.replace('/chatbot/hooks/', '/api/v1.1/rest/bot/').concat('/findIntent?fetchConfiguredTasks=false')
      }
    }
  }

  createAdminToken () {
    const adminClientId = this.caps[Capabilities.KOREAI_WEBHOOK_ADMIN_CLIENTID]
    const adminClientSecret = this.caps[Capabilities.KOREAI_WEBHOOK_ADMIN_CLIENTSECRET]
    if (!adminClientSecret || !adminClientId) {
      return null
    }

    return this.createToken(adminClientId, adminClientSecret)
  }

  createToken (clientId, clientSecret) {
    const tokenPayload = {
      isAnonymous: true
    }
    const tokenOptions = {
      algorithm: 'HS256',
      expiresIn: '1d',
      issuer: clientId || this.caps[Capabilities.KOREAI_WEBHOOK_CLIENTID],
      audience: 'https://idproxy.kore.ai/authorize',
      subject: this.fromId
    }
    const token = jwt.sign(tokenPayload, clientSecret || this.caps[Capabilities.KOREAI_WEBHOOK_CLIENTSECRET], tokenOptions)
    debug(`Generated token ${token} from payload "${util.inspect(tokenPayload)}", options "${util.inspect(tokenOptions)}"`)

    return token
  }

  UserSays (msg) {
    debug(`UserSays called ${util.inspect(msg)}`)
    return this._doRequest(msg)
  }

  Stop () {
    debug('Stop called')
    this.token = null
    this.adminToken = null
    this.fromId = null
    this.toId = null
  }

  _doRequest (msg) {
    const requestOptions = this._buildRequest(msg)
    debug(`constructed requestOptions ${JSON.stringify(requestOptions, null, 2)}`)

    return new Promise((resolve, reject) => {
      Promise.all([
        request(requestOptions.main),
        requestOptions.nlp ? request(requestOptions.nlp) : null
      ]).then(results => {
        resolve(this)
        const body = results && results.length > 0 ? results[0] : null
        if (!body) {
          debug(`body not found in response: ${JSON.stringify(results, null, 2)}`)
        } else {
          if (results.length > 1) {
            debug(`composite response, extracting just the first one: ${JSON.stringify(results, null, 2)}`)
          }
          debug(`got response body: ${JSON.stringify(body, null, 2)}`)
          let nlp = null
          const intentName = _.get(results, '[1].response.finalResolver.winningIntent[0].intent')
          if (intentName) {
            nlp = {
              intent: {
                name: intentName
              }
            }
          } else {
            if (results[1].response.result === 'failintent') {
              nlp = {
                intent: {
                  name: 'None',
                  incomprehension: true
                }
              }
            }
          }
          const entities = _.get(results, '[1].response.finalResolver.entities')
          if (entities && entities.length) {
            if (!nlp) {
              nlp = {}
            }
            nlp.entities = entities.map(e => {
              let value = null
            if (!e.value) {
              value = ''
            } else if (_.isArray(e.value) && e.value.length === 1) {
                if (!e.value[0]) {
                  value = ''
                } else {
                  // e.value is pure string like "2023-02-03", or json like
                  // {
                  //   "formatted_address": "London, UK",
                  //   "lat": 51.5072178,
                  //   "lng": -0.1275862
                  // }
                  value = _.isString(e.value[0]) ? e.value[0] : JSON.stringify(e.value[0])
                }
              } else {
                value = JSON.stringify(e.value)
              }
              return {
                name: e.field,
                value
              }
            })
          }
          if (body.text) {
            const messageTexts = (_.isArray(body.text) ? body.text : [body.text])
            messageTexts.filter(t => t).forEach((messageText) => {
              const botMsg = {
                sourceData: body,
                messageText
              }
              if (nlp) {
                botMsg.nlp = nlp
              }
              setTimeout(() => this.queueBotSays(botMsg), 0)
            })
          } else {
            if (nlp) {
              const botMsg = {
                sourceData: body,
                nlp
              }
              setTimeout(() => this.queueBotSays(botMsg), 0)
            }
          }
        }
      }).catch(err => {
        reject(new Error(`got error response from "${(err.options && err.options.uri) ? err.options.uri : 'N/A'}": ${err.statusCode}/${err.statusMessage}`))
      })
    })
  }

  _buildRequest (msg) {
    const uri = this.caps[Capabilities.KOREAI_WEBHOOK_URL]

    const main = {
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

    let nlp = null
    if (this.nlpAnalyticsUri && msg.messageText) {
      nlp = {
        uri: this.nlpAnalyticsUri,
        method: 'POST',
        headers: {
          auth: `${this.token}`
        },
        json: {
          input: msg.messageText,
          streamName: this.caps[Capabilities.KOREAI_WEBHOOK_BOTNAME]
        }
      }
    }
    return {
      main,
      nlp
    }
  }
}

module.exports = BotiumConnectorKoreaiWebhook
