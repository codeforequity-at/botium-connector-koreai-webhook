const util = require('util')
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
      isAnonymous: true,
      appId: clientId || this.caps[Capabilities.KOREAI_WEBHOOK_CLIENTID]
    }
    const tokenOptions = {
      algorithm: 'HS256',
      expiresIn: '1d',
      audience: 'https://idproxy.kore.ai/authorize',
      subject: this.fromId
    }
    const token = jwt.sign(tokenPayload, clientSecret || this.caps[Capabilities.KOREAI_WEBHOOK_CLIENTSECRET], tokenOptions)
    debug(`Generated token ${token} from payload "${util.inspect(tokenPayload)}", options "${util.inspect(tokenOptions)}"`)

    return token
  }

  UserSays (msg, timeout = 10000) {
    debug(`UserSays called ${util.inspect(msg)}`)
    return this._doRequest(msg, timeout)
  }

  Stop () {
    debug('Stop called')
    this.token = null
    this.adminToken = null
    this.fromId = null
    this.toId = null
  }

  _extractCustomComponents (entry) {
    const _extractButtonToSubcard = (element) => {
      if (element.type === 'button') {
        const action = element.click?.actions?.[0] || {}
        if (action.type === 'publishText') {
          return {
            buttons: [{
              text: element.title || 'No title defined',
              payload: action.text || 'No text defined'
            }]
          }
        } else if (action.type === 'link') {
          return {
            buttons: [{
              text: element.title || 'No title defined',
              payload: action.web?.uri || 'No URL defined'
            }]
          }
        } else {
          debug(`Unsupported button action type: ${action.type} in: ${JSON.stringify(element)}`)
        }
      } else {
        debug(`Unsupported element type on extracting button: ${element.type} in element: ${JSON.stringify(element)}`)
      }
    }

    if (entry.type === 'ContentEvent') {
      debug(`Customer specific format "${entry.type}" detected, processing...`)
      // extract buttons from quick replies to card.
      // maybe this could be put into the buttons field? Button can't be a link, isnt it?,
      return { text: entry.message, cards: (entry.quickReplies?.replies || []).map(_extractButtonToSubcard) }
    } else if (entry.type === 'RichContentEvent') {
      if (entry.content.type === 'vertical' || entry.content.type === 'carousel') {
        debug(`Customer specific format "${entry.type}"."${entry.content.type}" detected, processing...`)
        const _extractComponentsRecursive = (elements) => {
          const cards = elements.map((element) => {
            if (element.type === 'vertical' || element.type === 'carousel') {
              return {
                cards: _extractComponentsRecursive(element.elements)
              }
            } else if (element.type === 'text') {
              return {
                text: element.text
              }
            } else if (element.type === 'accordion') {
              return {
                text: element.text,
                cards: _extractComponentsRecursive(element.elements)
              }
            } else if (element.type === 'button') {
              const asCard = _extractButtonToSubcard(element)
              if (asCard) {
                return asCard
              }
              return false
            } else {
              debug(`Unsupported element type: ${element.type} in: ${JSON.stringify(element)}`)
              return false
            }
          }).filter(element => element)

          return cards
        }

        return { cards: _extractComponentsRecursive(entry.content.elements) }
      }
    }
    return null
  }

  _doRequest (msg, timeout) {
    const requestOptions = this._buildRequest(msg)
    const controller = new AbortController()

    // Set timeout to abort fetch after X ms
    const timeoutMs = timeout
    const timeoutId = setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    return new Promise((resolve, reject) => {
      Promise.all([
        fetch(requestOptions.main.url, {
          method: requestOptions.main.method,
          headers: requestOptions.main.headers,
          body: JSON.stringify(requestOptions.main.data),
          signal: controller.signal
        }).then(res => res.json()).catch(err => {
          debug(`Error in main request: ${err.message}`)
          throw err
        }
        ),

        requestOptions.nlp
          ? fetch(requestOptions.nlp.url, {
            method: requestOptions.nlp.method,
            headers: requestOptions.nlp.headers,
            body: JSON.stringify(requestOptions.nlp.data),
            signal: controller.signal
          }).then(res => res.json()).catch(err => {
            debug(`Error in NLP request: ${err.message}`)
            throw err
          }
          )
          : null
      ])
        .then(results => {
          resolve(this)
          const mainData = results[0]
          const nlpData = results[1]
          const body = mainData || null
          if (!body) {
            debug(`body not found in response: ${JSON.stringify(results, null, 2)}`)
          } else {
            let nlp = null
            debug(`got response body: ${JSON.stringify(body, null, 2)}`)
            if (nlpData?.response) {
              debug(`got nlp response: ${JSON.stringify(nlpData.response)}`)
              if (nlpData.response.finalResolver && nlpData.response.result !== 'failintent') {
                debug('no final resolver, unknown reason')
              }
              const intentName = _.get(nlpData, 'response.finalResolver.winningIntent[0].intent')
              if (intentName) {
                nlp = {
                  intent: {
                    name: intentName
                  }
                }
              } else if (nlpData.response.result === 'failintent') {
                nlp = {
                  intent: {
                    name: 'None',
                    incomprehension: true
                  }
                }
              }
              const entities = _.get(nlpData, 'response.finalResolver.entities')
              if (entities && entities.length) {
                if (!nlp) {
                  nlp = {}
                }
                nlp.entities = entities.map(e => ({
                  name: e.field,
                  value: e.value
                    ? _.isArray(e.value) && e.value.length === 1
                      ? _.isString(e.value[0])
                        ? e.value[0]
                        : JSON.stringify(e.value[0])
                      : JSON.stringify(e.value)
                    : ''
                }))
              }
            }

            let forms = null
            // all other rich components are stored in the text fied.
            if (body.form) {
              if (!body.form.formDef?.components.length) {
                debug(`cant process form, skipped: ${JSON.stringify(body.form)}`)
              } else {
                forms = []
                const componentToBotiumFormat = (c) => {
                  const md = c.metaData
                  if (!md) {
                    debug(`metaData missing: ${JSON.stringify(c)}`)
                    return null
                  }

                  const converted = {
                    name: md.name,
                    label: md.displayName
                  }
                  // dont understand they concept with the default values. Just collected the possible sources
                  const def = md.defaultvalueInput || c.defaultvalueInput || md.defaultvalueDateInput || md.defaultvalueInputNum || md.toggleDefaultValue
                  if (!_.isNil(def)) {
                    converted.value = def
                  } else if (md.values && md.values.find(({ selected }) => selected)) {
                  // and for radiobutton, and checkbox
                    converted.value = md.values.find(({ selected }) => selected).value
                  }

                  switch (md.type) {
                    case 'textField':
                    case 'textArea':
                    case 'phoneNumber':
                    case 'email':
                    case 'address':
                    case 'url':
                    case 'password':
                      converted.type = 'Text'
                      break
                    case 'number':
                    case 'rangeSlider':
                      converted.type = 'Number'
                      break
                    case 'radio':
                    case 'checkbox':
                      converted.type = 'RadioSet'
                      break
                    case 'dropdown':
                      converted.type = 'ChoiceSet'
                      break
                    case 'date':
                      converted.type = 'Date'
                      break
                    case 'toggle':
                      converted.type = 'Toggle'
                      break
                    default:
                      debug(`component not supported, skipped: ${JSON.stringify(c)}`)
                  }

                  return converted
                }
                for (const c of body.form.formDef.components) {
                  if (c.components?.length) {
                    for (const sub of c.components) {
                      const converted = componentToBotiumFormat(sub)
                      if (converted) {
                        forms.push(converted)
                      }
                    }
                  } else {
                    if (!c.metaData) {
                      debug(`metaData missing: ${JSON.stringify(c)}`)
                    } else {
                      const converted = componentToBotiumFormat(c)
                      if (converted) {
                        forms.push(converted)
                      }
                    }
                  }
                }
              }
            }
            if (body.text) {
              const texts = (_.isArray(body.text) ? body.text : [body.text])
              texts.filter(t => t).forEach((text) => {
                let asJson = null
                try {
                  asJson = JSON.parse(_.unescape(text))
                } catch (err) {}

                let messageText = null
                let buttons = null
                let media = null
                let cards = null
                if (asJson) {
                  debug(`response as json: ${JSON.stringify(asJson)}`)
                  const customComponents = this._extractCustomComponents(asJson)
                  if (customComponents) {
                    messageText = customComponents.text
                    buttons = customComponents.buttons
                    media = customComponents.media
                    cards = customComponents.cards
                  } else if (asJson.file) {
                  // {"file":{"type":"link","payload":{"url":"...","title":"...","template_type":"attachment"}}}
                    if (asJson.file.type === 'link') {
                      media = [{
                        mediaUri: asJson.file.payload.url,
                        altText: asJson.file.payload.title
                      }]
                    } else {
                      debug('unknown file format')
                    }
                  } else if (asJson.text) {
                    messageText = asJson.text
                  } else if (asJson.type === 'template' && asJson?.payload?.template_type) {
                    messageText = asJson.payload.text
                    switch (asJson.payload.template_type) {
                    // --- BUTTON ---
                      case 'button':
                      // If I created this button, then I set just one value, "Button1".
                      // So I suppose just the title is important for me
                      // {"type":"postback","title":"Button1","payload":"button1","value":"button1"}
                        buttons = asJson.payload.buttons.map(({ title, payload }) => ({
                          text: title,
                          payload: payload
                        }))
                        break
                        // --- QUICK REPLY ---
                      case 'quick_replies':
                      // {"content_type":"text","title":"B1","payload":"button1","image_url":"https:...","value":"button1"}
                        buttons = asJson.payload.quick_replies.map(({ title, payload }) => ({
                          text: title,
                          payload: payload
                        }))
                        break
                      case 'carousel':
                      // default_action is not used. its always
                      // {
                      //   "type": "web_url",
                      //   "url": ""
                      // }
                      // eslint-disable-next-line camelcase
                        cards = asJson.payload.elements.map((element) => ({
                          text: [element.title, element.subtitle],
                          image: { mediaUri: element.image_url },
                          buttons: element.buttons.map(({ title, payload }) => ({
                            text: title,
                            payload: payload
                          })),
                          sourceData: element
                        }))
                        break
                      default:
                        debug(`Not supported template type: ${asJson.payload.template_type} in: ${JSON.stringify(asJson, null, 2)}`)

                        break
                    }
                  } else {
                    debug(`Not supported json: ${JSON.stringify(asJson, null, 2)}`)
                  }
                } else {
                // --- CONFIRMATION ---
                // "This is a confirmation\nYes, No, "
                  if (text.endsWith('\nYes, No, ')) {
                    messageText = text.substring(0, text.length - '\nYes, No, '.length)
                    buttons = [
                      { text: 'Yes' },
                      { text: 'No' }
                    ]
                  } else {
                    messageText = text
                  }
                }
                const botMsg = {
                  sourceData: body
                }
                if (messageText) {
                  botMsg.messageText = messageText
                }
                if (buttons) {
                  botMsg.buttons = buttons
                }
                if (media) {
                  botMsg.media = media
                }
                if (cards) {
                  botMsg.cards = cards
                }
                if (nlp) {
                  botMsg.nlp = nlp
                  nlp = null
                }
                if (forms) {
                  botMsg.forms = forms
                  forms = null
                }
                debug(`Message with text converted to Botium format: ${JSON.stringify(botMsg)}`)
                setTimeout(() => this.queueBotSays(botMsg), 0)
              })
            } else {
              if (nlp || forms) {
                const botMsg = {
                  sourceData: body
                }
                if (nlp) {
                  botMsg.nlp = nlp
                  nlp = null
                }
                if (forms) {
                  botMsg.forms = forms
                  forms = null
                }
                debug(`Message without text converted to Botium format: ${JSON.stringify(botMsg)}`)
                setTimeout(() => this.queueBotSays(botMsg), 0)
              }
            }
          }
        })
        .catch(err => {
          reject(new Error(`failed to call endpoint "${requestOptions.main.url}" error message "${err.message}"`))
        })
        .finally(() => {
          clearTimeout(timeoutId)
        })
    })
  }

  _buildRequest (msg) {
    const url = this.caps[Capabilities.KOREAI_WEBHOOK_URL]

    const main = {
      url,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      data: {
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
        url: this.nlpAnalyticsUri,
        method: 'POST',
        headers: {
          auth: `${this.token}`,
          'Content-Type': 'application/json'
        },
        data: {
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
