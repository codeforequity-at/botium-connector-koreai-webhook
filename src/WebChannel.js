const { v4: uuidv4 } = require('uuid')
const _ = require('lodash')
const debug = require('debug')('botium-connector-koreai-webhook:webchannel')
const WebSocket = require('ws')

const Capabilities = require('./Capabilities')

class WebChannel {
  constructor (connector) {
    this.connector = connector
    this.ws = null
    this.botInfo = null
    this.accessToken = null
    this._stopping = false
    // its promise to fix this scenario occured before:
    // 1. user says "Hello"
    // 2. NLP analytics is requested, and running.
    // 3. bot sends welcome message
    // 4. we convert welcome message to botium format, but without NLP analytics
    // 5. NLP analytics returns NLP info
    this.lastNlpPromise = null
    this._wsOnMessage = null
    this._wsOnClose = null
    this._wsOnError = null
  }

  async Start () {
    if (this.accessToken || this.ws) {
      debug('WebChannel already started, restarting')
      await this.Stop()
    }
    this._stopping = false
    const caps = this.connector.caps || {}

    const clientId = caps[Capabilities.KOREAI_WEBHOOK_CLIENTID]
    const clientSecret = caps[Capabilities.KOREAI_WEBHOOK_CLIENTSECRET]
    if (!clientId) throw new Error('KOREAI_WEBHOOK_CLIENTID capability required for Web/Mobile Client channel')
    if (!clientSecret) throw new Error('KOREAI_WEBHOOK_CLIENTSECRET capability required for Web/Mobile Client channel')

    const botName = caps[Capabilities.KOREAI_WEBHOOK_BOTNAME]
    if (!botName) throw new Error('KOREAI_WEBHOOK_BOTNAME capability required for Web/Mobile Client channel (Kore RTM botInfo.chatBot)')

    const taskBotId = caps[Capabilities.KOREAI_WEBHOOK_BOTID]
    if (!taskBotId) throw new Error('KOREAI_WEBHOOK_BOTID capability required for Web/Mobile Client channel (or provide KOREAI_WEBHOOK_URL so it can be extracted)')

    let baseUrl = caps[Capabilities.KOREAI_WEBHOOK_BASE_URL]
    if (!baseUrl) throw new Error('KOREAI_WEBHOOK_BASE_URL capability required for Web/Mobile Client channel')

    baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl

    // Web/Mobile Client: JWT grant exchange for accessToken
    const jwtToken = this.connector.createToken(clientId, clientSecret)
    this.botInfo = { chatBot: botName, taskBotId }

    const jwtGrantUrl = new URL('/api/1.1/oAuth/token/jwtgrant', baseUrl).toString()
    debug(`Starting WebChannel via jwtgrant ${jwtGrantUrl} botInfo=${JSON.stringify(this.botInfo)}`)

    const jwtGrantRes = await fetch(jwtGrantUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assertion: jwtToken, botInfo: this.botInfo })
    })
    if (!jwtGrantRes.ok) {
      const bodyText = await jwtGrantRes.text()
      throw new Error(`jwtgrant HTTP ${jwtGrantRes.status}: ${bodyText.substring(0, 2000)}`)
    }
    const jwtGrantData = await jwtGrantRes.json()
    this.accessToken = jwtGrantData?.authorization?.accessToken || jwtGrantData?.accessToken
    if (!this.accessToken) throw new Error(`jwtgrant response missing accessToken: ${JSON.stringify(jwtGrantData).substring(0, 2000)}`)

    // Acquire WebSocket URL
    const rtmStartUrl = new URL('/api/1.1/rtm/start', baseUrl).toString()
    const customData = this.connector.GetCustomData(null)
    const botInfoWithCustomData = (customData && Object.keys(customData).length > 0)
      ? { ...this.botInfo, customData }
      : this.botInfo
    this.botInfo = botInfoWithCustomData
    const rtmStartRes = await fetch(rtmStartUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `bearer ${this.accessToken}`
      },
      body: JSON.stringify({ botInfo: botInfoWithCustomData })
    })
    if (!rtmStartRes.ok) {
      const bodyText = await rtmStartRes.text()
      throw new Error(`rtm/start HTTP ${rtmStartRes.status}: ${bodyText.substring(0, 2000)}`)
    }
    const rtmStartData = await rtmStartRes.json()
    const wsUrl = rtmStartData?.url
    if (!wsUrl) throw new Error(`rtm/start response missing url: ${JSON.stringify(rtmStartData).substring(0, 2000)}`)

    await this._connectWebSocket(wsUrl)
    debug('WebChannel started')
  }

  async Stop () {
    this._stopping = true
    this.lastNlpPromise = null
    if (this.ws) {
      try {
        if (this._wsOnMessage) this.ws.off('message', this._wsOnMessage)
        if (this._wsOnClose) this.ws.off('close', this._wsOnClose)
        if (this._wsOnError) this.ws.off('error', this._wsOnError)
        this.ws.close()
      } catch (err) {
        debug(`Error closing WebSocket: ${err.message}`)
      }
    }
    this.ws = null
    this._wsOnMessage = null
    this._wsOnClose = null
    this._wsOnError = null
    this.accessToken = null
    this.botInfo = null
  }

  async _connectWebSocket (wsUrl) {
    debug(`Connecting WebSocket ${wsUrl}`)
    const ws = new WebSocket(wsUrl)
    this.ws = ws

    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onError = (err) => {
        cleanup()
        reject(err)
      }
      const cleanup = () => {
        ws?.off('open', onOpen)
        ws?.off('error', onError)
      }

      ws.on('open', onOpen)
      ws.on('error', onError)
    })

    this._wsOnMessage = async (data) => {
      if (this._stopping || !this.ws || this.ws !== ws) return
      let evt
      try {
        evt = JSON.parse(data.toString())
      } catch (err) {
        debug(`Error parsing message: ${err.message}`)
        return
      }
      if (evt?.type === 'bot_response') {
        debug(`WebSocket event received (accepted): ${evt?.type || 'unknown'} ${JSON.stringify(evt).substring(0, 2500)}`)
        try {
          const botMsgs = await this.ExtractBotResponses(evt)
          botMsgs.forEach(botMsg => {
            if (botMsg) {
              setTimeout(() => this.connector.queueBotSays(botMsg), 0)
            }
          })
        } catch (err) {
          debug(`WebSocket event received (failed to process, ${err.message}): ${evt?.type || 'unknown'} ${JSON.stringify(evt).substring(0, 500)}`)
        }
      } else {
        debug(`WebSocket event received (ignored): ${evt?.type || 'unknown'} ${JSON.stringify(evt).substring(0, 500)}`)
      }
    }

    this._wsOnClose = () => {
      debug('WebSocket closed')
      if (this.ws === ws) this.ws = null
    }

    this._wsOnError = (err) => {
      debug(`WebSocket error: ${err?.message || err}`)
    }

    ws.on('message', this._wsOnMessage)
    ws.on('close', this._wsOnClose)
    ws.on('error', this._wsOnError)
  }

  async DoRequest (msg, options = {}) {
    if (!this.ws) throw new Error('WebChannel not connected (missing WebSocket), call Start() first')
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error(`WebChannel WebSocket not open (readyState=${this.ws.readyState}), call Start() first`)
    this.lastNlpPromise = null
    const textToSend = msg?.messageText || ''
    const { nlpDisabled = false } = options

    const id = uuidv4()
    const evt = {
      clientMessageId: id,
      message: { body: textToSend, attachments: [] },
      resourceid: '/bot.message',
      botInfo: this.botInfo,
      id
    }

    evt.customData = this.connector.GetCustomData(msg.SET_KOREAI_WEBHOOK_CUSTOM_DATA)

    if (this.connector?.nlpAnalyticsUri && textToSend && !nlpDisabled) {
      debug(`Requesting NLP analytics request for text: ${textToSend}`)
      // Never let NLP analytics failure block bot responses.
      this.lastNlpPromise = this._requestNlpAnalytics(textToSend)
        .catch(err => {
          debug(`NLP analytics request failed: ${err?.message || err}`)
          return null
        })
    } else {
      debug(`Skipping NLP analytics request. nlpDisabled: ${nlpDisabled}, textToSend: ${textToSend}, nlpAnalyticsUri: ${this.connector?.nlpAnalyticsUri}`)
      this.lastNlpPromise = null
    }

    debug(`Sending message over WebSocket: ${JSON.stringify(evt)}`)
    try {
      this.ws.send(JSON.stringify(evt))
    } catch (err) {
      debug(`Error sending message over WebSocket: ${err.message}`)
      throw err
    }

    return this.connector
  }

  async _requestNlpAnalytics (text) {
    const caps = this.connector?.caps || {}
    const token = this.connector?.token
    const url = this.connector?.nlpAnalyticsUri
    const streamName = caps[Capabilities.KOREAI_WEBHOOK_BOTNAME]

    if (!url || !token || !streamName || !text) return null

    const controller = new AbortController()
    const timeout = (caps.WAITFORBOTTIMEOUT || 10000) * 1.1
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          auth: `${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ input: text, streamName }),
        signal: controller.signal
      })
      if (!res.ok) {
        const bodyText = await res.text()
        throw new Error(`NLP analytics HTTP ${res.status}: ${bodyText.substring(0, 500)}`)
      }
      const contentType = res.headers.get('content-type')
      if (!contentType || !contentType.includes('application/json')) {
        const bodyText = await res.text()
        throw new Error(`NLP analytics expected JSON but got: ${bodyText.substring(0, 200)}`)
      }
      const nlpData = await res.json()
      return this._buildNlpFromAnalyticsResponse(nlpData)
    } finally {
      clearTimeout(timeoutId)
    }
  }

  _buildNlpFromAnalyticsResponse (nlpData) {
    if (!nlpData?.response) return null

    let nlp = null
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
            ? _.isString(e.value[0])
              ? e.value[0]
              : JSON.stringify(e.value[0])
            : JSON.stringify(e.value)
          : ''
      }))
    }

    return nlp
  }

  async ExtractBotResponses (evt) {
    const botMsgs = []
    // Snapshot the promise to avoid races with overlapping DoRequest() calls.
    const nlpPromise = this.lastNlpPromise
    let nlp = null
    if (nlpPromise) {
      try {
        nlp = await nlpPromise
      } catch (err) {
        // Should not happen because DoRequest() catches, but keep it extra-safe.
        debug(`NLP analytics promise failed (ignored): ${err?.message || err}`)
        nlp = null
      }
    }
    for (const msg of (evt?.message || [])) {
      debug(`Bot message, Kore.ai format: ${JSON.stringify(msg).substring(0, 2500)}`)
      let asJson = null
      try {
        asJson = msg?.cInfo?.body ? JSON.parse(_.unescape(msg.cInfo.body)) : null
      } catch (err) {}

      const botMsg = asJson ? this.connector.ExtractMessagePartsFromJson(asJson) : { messageText: msg?.cInfo?.body ? _.unescape(msg.cInfo.body) : msg?.cInfo?.body }
      botMsg.sourceData = msg
      if (nlp) botMsg.nlp = nlp
      debug(`Bot message, botium format: ${JSON.stringify(botMsg).substring(0, 2500)}`)

      if (botMsg !== null) botMsgs.push(botMsg)
    }

    return botMsgs
  }
}

module.exports = WebChannel
