const util = require('util')
const { v4: uuidv4 } = require('uuid')
const jwt = require('jsonwebtoken')
const _ = require('lodash')
const debug = require('debug')('botium-connector-koreai-webhook')
const { XMLParser } = require('fast-xml-parser')

const Capabilities = require('./Capabilities')
class BotiumConnectorKoreaiWebhook {
  constructor ({ queueBotSays, caps }) {
    this.queueBotSays = queueBotSays
    this.caps = caps
    this.token = null
    this.adminToken = null
    this.fromId = null
    this.nlpAnalyticsUri = null
    this.ivr_ani = null
    this.callId = null
    this.toId = null
    this.url = null
  }

  Validate () {
    debug('Validate called')

    if (!this.caps[Capabilities.KOREAI_WEBHOOK_URL]) throw new Error('KOREAI_WEBHOOK_URL capability required')
    if (!this.caps[Capabilities.KOREAI_WEBHOOK_CLIENTID]) throw new Error('KOREAI_WEBHOOK_CLIENTID capability required')
    if (!this.caps[Capabilities.KOREAI_WEBHOOK_CLIENTSECRET]) throw new Error('KOREAI_WEBHOOK_CLIENTSECRET capability required')
    if (this.caps[Capabilities.KOREAI_WEBHOOK_NLP_ANALYTICS_ENABLE] && !this.caps[Capabilities.KOREAI_WEBHOOK_BOTNAME]) throw new Error('KOREAI_WEBHOOK_BOTNAME capability required for NLP Analytics')

    if (this.caps[Capabilities.KOREAI_WEBHOOK_WELCOME_KOREAI_URL] || this.caps[Capabilities.KOREAI_WEBHOOK_WELCOME_KOREAI_TEXT]) {
      if (!this.caps[Capabilities.KOREAI_WEBHOOK_WELCOME_KOREAI_CLIENTID]) throw new Error('KOREAI_WEBHOOK_WELCOME_KOREAI_CLIENTID capability required')
      if (!this.caps[Capabilities.KOREAI_WEBHOOK_WELCOME_KOREAI_CLIENTSECRET]) throw new Error('KOREAI_WEBHOOK_WELCOME_KOREAI_CLIENTSECRET capability required')
      if (!this.caps[Capabilities.KOREAI_WEBHOOK_WELCOME_KOREAI_URL]) throw new Error('KOREAI_WEBHOOK_WELCOME_KOREAI_URL capability required')
      if (!this.caps[Capabilities.KOREAI_WEBHOOK_WELCOME_KOREAI_TEXT]) throw new Error('KOREAI_WEBHOOK_WELCOME_KOREAI_TEXT capability required')
    }
    return Promise.resolve()
  }

  async Start () {
    debug('Start called')

    this.url = this.caps[Capabilities.KOREAI_WEBHOOK_URL]
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
    this.callId = this.caps[Capabilities.KOREAI_WEBHOOK_IVR_CALLID] || uuidv4()
    if (this.caps[Capabilities.KOREAI_WEBHOOK_IVR_ANI]) {
      this.ivr_ani = this.caps[Capabilities.KOREAI_WEBHOOK_IVR_ANI]
    } else {
      // Generate random phone number as default (format: +1XXXXXXXXXX)
      const randomNumber = Math.floor(1000000000 + Math.random() * 9000000000)
      this.ivr_ani = `+1${randomNumber}`
    }

    if (this.caps[Capabilities.KOREAI_WEBHOOK_NLP_ANALYTICS_ENABLE]) {
      if (this.caps[Capabilities.KOREAI_WEBHOOK_NLP_ANALYTICS_URL]) {
        this.nlpAnalyticsUri = this.caps[Capabilities.KOREAI_WEBHOOK_NLP_ANALYTICS_URL]
      } else if (!this.caps[Capabilities.KOREAI_WEBHOOK_URL].indexOf('/chatbot/hooks/') > 0) {
        debug(`Webhook URL ${this.caps[Capabilities.KOREAI_WEBHOOK_URL]} is not valid, NLP analytics disabled`)
      } else {
        const normalizedUri = this.url.indexOf('/hookInstance/') > 0
          ? this.url.substring(0, this.url.indexOf('/hookInstance/'))
          : this.url
        this.nlpAnalyticsUri = normalizedUri.replace('/chatbot/hooks/', '/api/v1.1/rest/bot/').concat('/findIntent?fetchConfiguredTasks=false')
      }
    }
    // sending welcome message to another koreai bot. Customer request.
    if (!_.isNil(this.caps[Capabilities.KOREAI_WEBHOOK_WELCOME_KOREAI_URL])) {
      debug(`Sending welcome message ${this.caps[Capabilities.KOREAI_WEBHOOK_WELCOME_KOREAI_TEXT]} to bot: ${this.caps[Capabilities.KOREAI_WEBHOOK_WELCOME_KOREAI_URL]}`)
      try {
        await this._doRequest(
          {
            messageText: this.caps[Capabilities.KOREAI_WEBHOOK_WELCOME_KOREAI_TEXT]
          }, {
            nlpDisabled: true,
            token: this.createToken(this.caps[Capabilities.KOREAI_WEBHOOK_WELCOME_KOREAI_CLIENTID], this.caps[Capabilities.KOREAI_WEBHOOK_WELCOME_KOREAI_CLIENTSECRET]),
            url: this.caps[Capabilities.KOREAI_WEBHOOK_WELCOME_KOREAI_URL]
          })
      } catch (err) {
        debug(`Error sending welcome message to different bot: ${err.message}`)
        throw new Error(`Cannot send welcome message to different bot: ${err.message}`)
      }
    }
    if (!_.isNil(this.caps[Capabilities.KOREAI_WEBHOOK_WELCOME_TEXT])) {
      debug(`Sending welcome message ${this.caps[Capabilities.KOREAI_WEBHOOK_WELCOME_TEXT]} to bot`)
      try {
        await this._doRequest(
          {
            messageText: this.caps[Capabilities.KOREAI_WEBHOOK_WELCOME_TEXT]
          }, {
            nlpDisabled: true
          })
      } catch (err) {
        debug(`Error sending welcome message: ${err.message}`)
        throw new Error(`Cannot send welcome message: ${err.message}`)
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

  UserSays (msg, timeout) {
    debug(`UserSays called ${util.inspect(msg)}`)
    return this._doRequest(msg, { timeout, token: this.token })
  }

  Stop () {
    debug('Stop called')
    this.token = null
    this.adminToken = null
    this.fromId = null
    this.nlpAnalyticsUri = null
    this.ivr_ani = null
    this.callId = null
    this.toId = null
    this.url = null
  }

  /**
   * Parse VXML response from IVR bot to Botium format
   * Based on official Kore.ai IVR documentation: https://docs.kore.ai/xo/channels/IVR-integration/
   * @param {string} vxmlText - VXML response text
   * @returns {object} - Botium formatted message
   */
  _parseVXML (vxmlText) {
    debug(`Parsing VXML response: ${vxmlText.substring(0, 500)}...`)

    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        textNodeName: '#text',
        parseAttributeValue: true,
        trimValues: true
      })

      const parsed = parser.parse(vxmlText)
      debug(`Parsed VXML to JSON: ${JSON.stringify(parsed, null, 2)}`)

      const botMsg = {
        sourceData: { vxml: vxmlText, parsed }
      }

      let messageText = ''
      const buttons = []

      // Navigate VXML structure
      const vxml = parsed.vxml
      if (!vxml) {
        debug('No vxml root element found')
        return { messageText: vxmlText }
      }

      // Extract from form blocks
      const forms = _.isArray(vxml.form) ? vxml.form : (vxml.form ? [vxml.form] : [])

      for (const form of forms) {
        // Extract prompts (bot messages)
        if (form.block) {
          const blocks = _.isArray(form.block) ? form.block : [form.block]

          for (const block of blocks) {
            if (block.prompt) {
              const prompts = _.isArray(block.prompt) ? block.prompt : [block.prompt]

              for (const prompt of prompts) {
                let promptText = ''

                // Extract text from prompt
                if (typeof prompt === 'string') {
                  promptText = prompt
                } else if (prompt['#text']) {
                  promptText = prompt['#text']
                } else if (prompt.audio && prompt.audio['@_src']) {
                  // Audio file reference
                  promptText = `[Audio: ${prompt.audio['@_src']}]`
                } else if (prompt.value) {
                  // Dynamic value
                  promptText = prompt.value['@_expr'] || prompt.value['#text'] || ''
                }

                if (promptText) {
                  messageText += (messageText ? ' ' : '') + promptText.trim()
                }
              }
            }
          }
        }

        // Extract from field (user input with grammar/options)
        if (form.field) {
          const fields = _.isArray(form.field) ? form.field : [form.field]

          for (const field of fields) {
            // Extract field prompt
            if (field.prompt) {
              const prompts = _.isArray(field.prompt) ? field.prompt : [field.prompt]

              for (const prompt of prompts) {
                let promptText = ''

                if (typeof prompt === 'string') {
                  promptText = prompt
                } else if (prompt['#text']) {
                  promptText = prompt['#text']
                } else if (prompt.audio && prompt.audio['@_src']) {
                  promptText = `[Audio: ${prompt.audio['@_src']}]`
                }

                if (promptText) {
                  messageText += (messageText ? ' ' : '') + promptText.trim()
                }
              }
            }

            // Extract grammar/options (convert to buttons)
            if (field.grammar) {
              const grammars = _.isArray(field.grammar) ? field.grammar : [field.grammar]

              for (const grammar of grammars) {
                // Check for option elements (menu choices)
                if (grammar.option) {
                  const options = _.isArray(grammar.option) ? grammar.option : [grammar.option]

                  options.forEach((option, index) => {
                    const dtmf = option['@_dtmf'] || (index + 1).toString()
                    const value = option['@_value'] || option['#text'] || ''

                    buttons.push({
                      text: `${dtmf}. ${value}`,
                      payload: value
                    })
                  })
                }
              }
            }

            // Extract from option elements (for menus)
            if (field.option) {
              const options = _.isArray(field.option) ? field.option : [field.option]

              options.forEach((option, index) => {
                const dtmf = option['@_dtmf'] || (index + 1).toString()
                const value = option['@_value'] || option['#text'] || ''

                buttons.push({
                  text: `${dtmf}. ${value}`,
                  payload: value
                })
              })
            }
          }
        }

        // Extract from menu (IVR menu with choices)
        if (form.menu) {
          const menus = _.isArray(form.menu) ? form.menu : [form.menu]

          for (const menu of menus) {
            // Extract menu prompt
            if (menu.prompt) {
              const prompts = _.isArray(menu.prompt) ? menu.prompt : [menu.prompt]

              for (const prompt of prompts) {
                let promptText = ''

                if (typeof prompt === 'string') {
                  promptText = prompt
                } else if (prompt['#text']) {
                  promptText = prompt['#text']
                } else if (prompt.audio && prompt.audio['@_src']) {
                  promptText = `[Audio: ${prompt.audio['@_src']}]`
                }

                if (promptText) {
                  messageText += (messageText ? ' ' : '') + promptText.trim()
                }
              }
            }

            // Extract choices (menu options)
            if (menu.choice) {
              const choices = _.isArray(menu.choice) ? menu.choice : [menu.choice]

              choices.forEach((choice, index) => {
                const dtmf = choice['@_dtmf'] || (index + 1).toString()
                const next = choice['@_next'] || ''
                const text = choice['#text'] || next || ''

                buttons.push({
                  text: `${dtmf}. ${text}`,
                  payload: text
                })
              })
            }
          }
        }
      }

      // Add extracted data to bot message
      if (messageText) {
        botMsg.messageText = messageText.trim()
      }

      if (buttons.length > 0) {
        botMsg.buttons = buttons
      }

      debug(`Parsed VXML to Botium format: ${JSON.stringify(botMsg)}`)
      return botMsg
    } catch (err) {
      debug(`Error parsing VXML: ${err.message}`)
      // Return raw text if parsing fails
      return {
        messageText: vxmlText,
        sourceData: { vxml: vxmlText, error: err.message }
      }
    }
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

  _doRequest (msg, options = {}) {
    const requestOptions = this._buildRequest(msg, options)
    const controller = new AbortController()

    const timeoutId = setTimeout(() => {
      controller.abort()
    }, options.timeout || 10000)
    return new Promise((resolve, reject) => {
      Promise.all([
        fetch(requestOptions.main.url, {
          method: requestOptions.main.method,
          headers: requestOptions.main.headers,
          body: JSON.stringify(requestOptions.main.data),
          signal: controller.signal
        }).then(async (res) => {
          if (!res.ok) {
            const text = await res.text()
            debug(`Main request failed with HTTP ${res.status}: ${text}`)
            throw new Error(`HTTP ${res.status}: ${text.substring(0, 500)}`)
          }

          // Handle different content types (JSON or VXML for IVR bots)
          const contentType = res.headers.get('content-type')

          if (contentType && contentType.includes('application/json')) {
            // Standard JSON response
            return res.json()
          } else if (
            contentType &&
            (contentType.includes('application/voicexml+xml') ||
              contentType.includes('text/xml') ||
              contentType.includes('application/xml'))
          ) {
            // VXML response from IVR bot
            const vxmlText = await res.text()
            debug(`Received VXML response (${vxmlText.length} chars)`)

            // Parse VXML to Botium format
            const parsedVXML = this._parseVXML(vxmlText)
            return parsedVXML
          } else {
            // Unknown content type
            const text = await res.text()
            debug(`Unknown content-type: ${contentType}, returning as text`)
            return { messageText: text }
          }
        }).catch(err => {
          debug(`Error in main request: ${err.message}`)
          throw err
        }),

        requestOptions.nlp
          ? fetch(requestOptions.nlp.url, {
            method: requestOptions.nlp.method,
            headers: requestOptions.nlp.headers,
            body: JSON.stringify(requestOptions.nlp.data),
            signal: controller.signal
          }).then(async (res) => {
            if (!res.ok) {
              const text = await res.text()
              debug(`NLP request failed with HTTP ${res.status}: ${text}`)
              throw new Error(`HTTP ${res.status}: ${text.substring(0, 500)}`)
            }

            const contentType = res.headers.get('content-type')
            if (contentType && contentType.includes('application/json')) {
              return res.json()
            } else {
              const text = await res.text()
              throw new Error(`Expected JSON response but got: ${text.substring(0, 200)}`)
            }
          }).catch(err => {
            debug(`Error in NLP request: ${err.message}`)
            throw err
          })
          : null
      ])
        .then(results => {
          resolve(this)
          const mainData = results[0]
          const nlpData = results[1]

          // Check if response is already parsed VXML (from IVR bot)
          if (mainData && mainData.sourceData && mainData.sourceData.vxml) {
            debug('IVR VXML response detected, queuing parsed message')
            setTimeout(() => this.queueBotSays(mainData), 0)
            return
          }

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

  _buildRequest (msg, options = {}) {
    let {
      url = this.url,
      token = this.token,
      nlpDisabled = false
    } = options
    const headers = {
      'Content-Type': 'application/json'
    }

    const isIVR = url.includes('/ivr/hooks/')

    let requestData

    if (isIVR) {
      requestData = {
        callId: this.callId,
        message: msg.messageText,
        from: this.fromId
      }

      url = `${url}?token=${token}`

      if (this.caps[Capabilities.KOREAI_WEBHOOK_IVR_DNIS]) {
        requestData.ivr_dnis = this.caps[Capabilities.KOREAI_WEBHOOK_IVR_DNIS]
      }
      if (this.caps[Capabilities.KOREAI_WEBHOOK_IVR_DOMAIN]) {
        requestData.ivr_domain =
          this.caps[Capabilities.KOREAI_WEBHOOK_IVR_DOMAIN]
      }
      requestData.ivr_ani = this.ivr_ani

      debug(
        `IVR bot detected. Using IVR payload format: ${JSON.stringify(
          requestData
        )}`
      )
    } else {
      requestData = {
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

      // add token to headers for message bots
      headers.Authorization = `Bearer ${token}`

      debug(
        `Message bot detected. Using standard payload format: ${JSON.stringify(
          requestData
        )}`
      )
    }

    const main = {
      url,
      method: 'POST',
      headers,
      data: requestData
    }

    // NLP Analytics (only for message bots, not supported for IVR)
    let nlp = null
    if (!isIVR && this.nlpAnalyticsUri && msg.messageText && !nlpDisabled) {
      nlp = {
        url: this.nlpAnalyticsUri,
        method: 'POST',
        headers: {
          auth: `${token}`,
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
