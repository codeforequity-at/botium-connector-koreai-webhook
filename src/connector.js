const util = require('util')
const { v4: uuidv4 } = require('uuid')
const jwt = require('jsonwebtoken')
const _ = require('lodash')
const debug = require('debug')('botium-connector-koreai-webhook')
const { XMLParser } = require('fast-xml-parser')

const Capabilities = require('./Capabilities')
const WebChannel = require('./WebChannel')
class BotiumConnectorKoreaiWebhook {
  constructor ({ queueBotSays, caps }) {
    this.queueBotSays = queueBotSays
    this.caps = Object.assign({}, caps)
    if (this.caps[Capabilities.KOREAI_WEBHOOK_BASE_URL]) {
      let baseUrl = String(this.caps[Capabilities.KOREAI_WEBHOOK_BASE_URL]).trim()
      if (baseUrl && !/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(baseUrl)) baseUrl = `https://${baseUrl}`

      try {
        const parsed = new URL(baseUrl)
        // Normalize to protocol + hostname only (strip port, path, query, hash)
        this.caps[Capabilities.KOREAI_WEBHOOK_BASE_URL] = `${parsed.protocol}//${parsed.hostname}`
      } catch (err) {
        // Keep legacy behaviour as fallback (avoid breaking on invalid inputs)
        this.caps[Capabilities.KOREAI_WEBHOOK_BASE_URL] = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
      }
    }
    this.token = null
    this.adminToken = null
    this.fromId = null
    this.nlpAnalyticsUri = null
    this.customData = null
    this.ivr_ani = null
    this.callId = null
    this.toId = null
    this.url = null
  }

  GetCustomData (customDataFromMsg) {
    let customData = null
    if (!_.isNil(this.customData)) {
      customData = this.customData
    }
    const customDataMode = this.caps[Capabilities.KOREAI_WEBHOOK_CUSTOMDATA_MODE]

    if (customDataFromMsg) {
      customData = customDataMode === 'merge' ? Object.assign({}, customData || {}, customDataFromMsg) : customDataFromMsg
      debug(`Updated context with KOREAI_WEBHOOK_CUSTOM_DATA: ${JSON.stringify(customDataFromMsg)}`)
    }

    if (customDataMode === 'replace') {
      debug(`Updating (replace) customData session: ${JSON.stringify(this.customData)} current customData: ${JSON.stringify(customData)} message: ${customDataFromMsg}`)
      this.customData = customData
    } else if (customDataMode === 'merge') {
      debug(`Updating (merge) customData session: ${JSON.stringify(this.customData)} current customData: ${JSON.stringify(customData)} message: ${customDataFromMsg}`)
      this.customData = Object.assign({}, this.customData || {}, customData)
    } else {
      debug(`Updating (delete) customData session: ${JSON.stringify(this.customData)} current customData: ${JSON.stringify(customData)} message: ${customDataFromMsg}`)
      this.customData = null
    }

    return customData
  }

  Validate () {
    debug('Validate called')

    const isPureNlp = this.caps[Capabilities.KOREAI_WEBHOOK_CHANNEL] === 'Pure NLP'

    if (!isPureNlp && this.caps[Capabilities.KOREAI_WEBHOOK_CHANNEL] !== 'Web/Mobile Client') {
      if (!this.caps[Capabilities.KOREAI_WEBHOOK_URL]) throw new Error('KOREAI_WEBHOOK_URL capability required')
    }

    if (!this.caps[Capabilities.KOREAI_WEBHOOK_CLIENTID]) throw new Error('KOREAI_WEBHOOK_CLIENTID capability required')
    if (!this.caps[Capabilities.KOREAI_WEBHOOK_CLIENTSECRET]) throw new Error('KOREAI_WEBHOOK_CLIENTSECRET capability required')

    if (isPureNlp) {
      if (!this.caps[Capabilities.KOREAI_WEBHOOK_BOTNAME]) throw new Error('KOREAI_WEBHOOK_BOTNAME capability required for Pure NLP channel')
      if (!this.caps[Capabilities.KOREAI_WEBHOOK_BASE_URL] && !this.caps[Capabilities.KOREAI_WEBHOOK_NLP_ANALYTICS_URL]) {
        throw new Error('KOREAI_WEBHOOK_BASE_URL or KOREAI_WEBHOOK_NLP_ANALYTICS_URL capability required for Pure NLP channel')
      }
    } else if (this.caps[Capabilities.KOREAI_WEBHOOK_NLP_ANALYTICS_ENABLE] && !this.caps[Capabilities.KOREAI_WEBHOOK_BOTNAME]) {
      throw new Error('KOREAI_WEBHOOK_BOTNAME capability required for NLP Analytics')
    }

    return Promise.resolve()
  }

  Build () {
    if (this.caps[Capabilities.KOREAI_WEBHOOK_CHANNEL] === 'Web/Mobile Client') {
      this.webChannel = new WebChannel(this)
    }
  }

  async Start () {
    debug('Start called')

    const isPureNlp = this.caps[Capabilities.KOREAI_WEBHOOK_CHANNEL] === 'Pure NLP'

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
    this.callId = uuidv4()
    if (this.caps[Capabilities.KOREAI_WEBHOOK_IVR_ANI]) {
      this.ivr_ani = this.caps[Capabilities.KOREAI_WEBHOOK_IVR_ANI]
    } else {
      const randomNumber = Math.floor(1000000000 + Math.random() * 9000000000)
      this.ivr_ani = `+1${randomNumber}`
    }

    if (!_.isNil(this.caps[Capabilities.KOREAI_WEBHOOK_CUSTOMDATA])) {
      const customDataValue = this.caps[Capabilities.KOREAI_WEBHOOK_CUSTOMDATA]
      if (_.isPlainObject(customDataValue) || Array.isArray(customDataValue)) {
        this.customData = customDataValue
      } else if (typeof customDataValue === 'string') {
        if (customDataValue.length > 0) {
          try {
            this.customData = JSON.parse(customDataValue)
          } catch (err) {
            throw new Error(`KOREAI_WEBHOOK_CUSTOMDATA capability invalid JSON: ${err.message}`)
          }
        }
      } else {
        throw new Error('KOREAI_WEBHOOK_CUSTOMDATA capability has to be a JSON string or an object')
      }
    }

    if (isPureNlp || this.caps[Capabilities.KOREAI_WEBHOOK_NLP_ANALYTICS_ENABLE]) {
      if (this.caps[Capabilities.KOREAI_WEBHOOK_NLP_ANALYTICS_URL]) {
        this.nlpAnalyticsUri = this.caps[Capabilities.KOREAI_WEBHOOK_NLP_ANALYTICS_URL]
      } else {
        if (this.caps[Capabilities.KOREAI_WEBHOOK_BOTID] && this.caps[Capabilities.KOREAI_WEBHOOK_BASE_URL]) {
          this.nlpAnalyticsUri = `${this.caps[Capabilities.KOREAI_WEBHOOK_BASE_URL]}/api/v1.1/rest/bot/${this.caps[Capabilities.KOREAI_WEBHOOK_BOTID]}/findIntent?fetchConfiguredTasks=false`
        } else if (this.url) {
          const normalizedUri = this.url.indexOf('/hookInstance/') > 0
            ? this.url.substring(0, this.url.indexOf('/hookInstance/'))
            : this.url

          if (normalizedUri.indexOf('/chatbot/hooks/') > 0) {
            this.nlpAnalyticsUri = normalizedUri.replace('/chatbot/hooks/', '/api/v1.1/rest/bot/').concat('/findIntent?fetchConfiguredTasks=false')
          } else if (normalizedUri.indexOf('/ivr/hooks/') > 0) {
            this.nlpAnalyticsUri = normalizedUri.replace('/ivr/hooks/', '/api/v1.1/rest/bot/').concat('/findIntent?fetchConfiguredTasks=false')
            debug(`IVR NLP analytics enabled. Using endpoint: ${this.nlpAnalyticsUri}`)
          } else {
            this.nlpAnalyticsUri = normalizedUri.concat('/findIntent?fetchConfiguredTasks=false')
            debug(`Using fallback NLP analytics endpoint: ${this.nlpAnalyticsUri}`)
          }
        }
      }
      if (isPureNlp && !this.nlpAnalyticsUri) {
        throw new Error('Could not determine NLP Analytics URL for Pure NLP channel. Provide KOREAI_WEBHOOK_NLP_ANALYTICS_URL or KOREAI_WEBHOOK_BASE_URL + KOREAI_WEBHOOK_BOTID.')
      }
      if (isPureNlp) {
        debug(`Pure NLP mode enabled. Using NLP endpoint: ${this.nlpAnalyticsUri}`)
      }
    }

    if (!isPureNlp && this.webChannel) {
      await this.webChannel.Start()
    }

    if (!isPureNlp && this.caps[Capabilities.KOREAI_WEBHOOK_WELCOME_TEXT]) {
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

  createAdminToken (generateSubject = false) {
    const adminClientId = this.caps[Capabilities.KOREAI_WEBHOOK_ADMIN_CLIENTID]
    const adminClientSecret = this.caps[Capabilities.KOREAI_WEBHOOK_ADMIN_CLIENTSECRET]
    if (!adminClientSecret || !adminClientId) {
      return null
    }

    return this.createToken(adminClientId, adminClientSecret, generateSubject)
  }

  createToken (clientId, clientSecret, generateSubject = false) {
    const tokenPayload = {
      isAnonymous: true,
      appId: clientId || this.caps[Capabilities.KOREAI_WEBHOOK_CLIENTID]
    }
    const tokenOptions = {
      algorithm: 'HS256',
      expiresIn: '1d',
      audience: 'https://idproxy.kore.ai/authorize',
      // Kore jwtgrant expects issuer to be the clientId?
      issuer: clientId || this.caps[Capabilities.KOREAI_WEBHOOK_CLIENTID],
      subject: generateSubject ? uuidv4() : this.fromId // generate from downloader
    }
    const token = jwt.sign(tokenPayload, clientSecret || this.caps[Capabilities.KOREAI_WEBHOOK_CLIENTSECRET], tokenOptions)
    debug(`Generated token ${token} from payload "${util.inspect(tokenPayload)}", options "${util.inspect(tokenOptions)}"`)

    return token
  }

  UserSays (msg, timeout) {
    debug(`UserSays called ${util.inspect(msg)}`)
    return this._doRequest(msg, { timeout, token: this.token })
  }

  async Stop () {
    debug('Stop called')
    this.token = null
    this.adminToken = null
    this.fromId = null
    this.nlpAnalyticsUri = null
    this.ivr_ani = null
    this.callId = null
    this.toId = null
    this.url = null
    if (this.webChannel) {
      await this.webChannel.Stop()
    }
  }

  Clean () {
    debug('Clean called')
    this.webChannel = null
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

  ExtractMessagePartsFromJson (asJson) {
    let messageText = null
    let buttons = null
    let media = null
    let cards = null

    debug(`Message in Kore.ai format: ${JSON.stringify(asJson)}`)
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
      messageText = JSON.stringify(asJson, null, 2)
    }

    const msg = { messageText, buttons, media, cards }
    debug(`Message in Botium format: ${JSON.stringify(msg)}`)
    return msg
  }

  _doRequest (msg, options = {}) {
    if (this.caps[Capabilities.KOREAI_WEBHOOK_CHANNEL] === 'Pure NLP') {
      return this._doPureNlpRequest(msg, options)
    }
    if (this.caps[Capabilities.KOREAI_WEBHOOK_CHANNEL] === 'Web/Mobile Client') {
      if (!this.webChannel) {
        throw new Error('WebChannel not initialized, call Build() first')
      }
      return this.webChannel.DoRequest(msg, options)
    }
    const requestOptions = this._buildRequest(msg, options)
    const controller = new AbortController()
    const timeout = (options.timeout || this.caps.WAITFORBOTTIMEOUT || 10000) * 1.1
    const timeoutId = setTimeout(() => {
      debug(`Timeout ${timeout} reached, aborting request`)
      controller.abort()
    }, timeout)
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

          const body = mainData || null
          const isVXML = body && body.sourceData && body.sourceData.vxml
          if (isVXML) {
            debug('IVR VXML response detected, will process with NLP data')
          }
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
            // Handle both JSON responses (body.text) and VXML responses (body.messageText)
            if (body.text || body.messageText) {
              const texts = body.text
                ? (_.isArray(body.text) ? body.text : [body.text])
                : (body.messageText ? [body.messageText] : [])

              texts.filter(t => t).forEach((text) => {
                let asJson = null
                try {
                  asJson = JSON.parse(_.unescape(text))
                } catch (err) {}

                let messageText = null
                let buttons = null
                let media = null
                let cards = null

                // For VXML responses, check if buttons/media/cards are already parsed in body
                if (isVXML && body.buttons) {
                  buttons = body.buttons
                }
                if (isVXML && body.media) {
                  media = body.media
                }
                if (isVXML && body.cards) {
                  cards = body.cards
                }

                if (asJson) {
                  ({ messageText, buttons, media, cards } = this.ExtractMessagePartsFromJson(asJson))
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

  _doPureNlpRequest (msg, options = {}) {
    const token = options.token || this.token
    if (!this.nlpAnalyticsUri) {
      return Promise.reject(new Error('NLP Analytics URI not configured for Pure NLP channel'))
    }
    if (!msg.messageText) {
      return Promise.reject(new Error('No message text provided for Pure NLP request'))
    }

    const nlpRequest = {
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

    const controller = new AbortController()
    const timeout = (options.timeout || this.caps.WAITFORBOTTIMEOUT || 10000) * 1.1
    const timeoutId = setTimeout(() => {
      debug(`Pure NLP timeout ${timeout} reached, aborting request`)
      controller.abort()
    }, timeout)

    return new Promise((resolve, reject) => {
      fetch(nlpRequest.url, {
        method: nlpRequest.method,
        headers: nlpRequest.headers,
        body: JSON.stringify(nlpRequest.data),
        signal: controller.signal
      })
        .then(async (res) => {
          if (!res.ok) {
            const text = await res.text()
            throw new Error(`Pure NLP request failed with HTTP ${res.status}: ${text.substring(0, 500)}`)
          }
          return res.json()
        })
        .then((nlpData) => {
          resolve(this)

          let nlp = null
          if (nlpData?.response) {
            const intentName = _.get(nlpData, 'response.finalResolver.winningIntent[0].intent')
            if (intentName) {
              nlp = { intent: { name: intentName } }
            } else if (nlpData.response.result === 'failintent') {
              nlp = { intent: { name: 'None', incomprehension: true } }
            }
            const entities = _.get(nlpData, 'response.finalResolver.entities')
            if (entities && entities.length) {
              if (!nlp) nlp = {}
              nlp.entities = entities.map(e => ({
                name: e.field,
                value: e.value
                  ? _.isArray(e.value) && e.value.length === 1
                    ? _.isString(e.value[0]) ? e.value[0] : JSON.stringify(e.value[0])
                    : JSON.stringify(e.value)
                  : ''
              }))
            }
          }

          const botMsg = {
            sourceData: nlpData
          }
          if (nlp) {
            botMsg.nlp = nlp
          }
          debug(`Pure NLP response converted to Botium format: ${JSON.stringify(botMsg)}`)
          setTimeout(() => this.queueBotSays(botMsg), 0)
        })
        .catch(err => {
          reject(new Error(`Pure NLP request to "${this.nlpAnalyticsUri}" failed: ${err.message}`))
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

      debug('Getting customData 1')
      requestData.customData = this.GetCustomData(msg.SET_KOREAI_WEBHOOK_CUSTOM_DATA)

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
      debug('Getting customData 2')
      requestData.customData = this.GetCustomData(msg.SET_KOREAI_WEBHOOK_CUSTOM_DATA)

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

    // NLP Analytics (supported for both message bots and IVR bots)
    let nlp = null
    if (this.nlpAnalyticsUri && msg.messageText && !nlpDisabled) {
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
