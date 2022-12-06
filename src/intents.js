const _ = require('lodash')
const { BotDriver } = require('botium-core')
const debug = require('debug')('botium-connector-inbenta-intents')
const rp = require('request-promise-native')

const Capabilities = require('./Capabilities')

const getCaps = (caps) => {
  const result = caps || {}
  return result
}

const extractUrl = (container) => {
  const uriWebhook = container.pluginInstance.caps[Capabilities.KOREAI_WEBHOOK_URL]
  if (uriWebhook.indexOf('/chatbot/hooks/') < 0) {
    throw new Error(`Webhook URL ${uriWebhook} is not valid, download failed`)
  } else {
    const normalizedUri = uriWebhook.indexOf('/hookInstance/') > 0
      ? uriWebhook.substring(0, uriWebhook.indexOf('/hookInstance/'))
      : uriWebhook
    const splitted = normalizedUri.split('/chatbot/hooks/')
    if (splitted.length !== 2) {
      throw new Error(`Webhook URL ${uriWebhook} is not valid, download failed`)
    }
    const urlRoot = splitted[0].concat('/api/public')
    const botId = splitted[1]
    return { urlRoot, botId }
  }
}

const getContent = async ({ container, statusCallback }) => {
  const status = (log, obj) => {
    debug(log, obj)
    if (statusCallback) statusCallback(log, obj)
  }

  const { urlRoot, botId } = extractUrl(container)

  //
  // Start download
  //
  const roStart = {
    uri: `${urlRoot}/bot/${botId}/mlexport?state=configured&=&type=json`,
    method: 'POST',
    headers: {
      auth: `${container.pluginInstance.token}`
    },
    json: true,
    transform: (body, response) => ({
      response,
      body
    })
  }
  status(`Constructed requestOptions for mlexport: ${JSON.stringify(roStart, null, 2)}`)
  const { body, response } = await rp(roStart)
  let streamId = null
  if (response.statusCode >= 400) {
    status(`got error response for mlexport: ${response.statusCode}/${response.statusMessage}`)
    throw new Error(`got error response for mlexport: ${response.statusCode}/${response.statusMessage}`)
  }
  // It looks the streamId can be used to check the status (doc says: "it creates a request ID from which we can generate
  // the Download link of the bot using ML Utterance Export Status API." But there is no requestId.) StreamId is the same
  // as botId, maybe because there are no parallel downloads
  streamId = body.streamId

  //
  // Checking download status
  //
  const roStatus = {
    uri: `${urlRoot}/bot/${streamId}/mlexport/status`,
    method: 'GET',
    headers: {
      auth: `${container.pluginInstance.token}`
    },
    json: true,
    transform: (body, response) => ({
      response,
      body
    })
  }
  status(`Constructed requestOptions for mlexport/status: ${JSON.stringify(roStatus, null, 2)}`)
  let downloadUrl = null

  for (let tries = 0; tries < 20 && !downloadUrl; tries++) {
    const { body, response } = await rp(roStatus)
    if (response.statusCode >= 400) {
      status(`got error response for mlexport/status: ${response.statusCode}/${response.statusMessage}`)
      throw new Error(`got error response for mlexport/status: ${response.statusCode}/${response.statusMessage}`)
    }
    downloadUrl = body.downloadUrl
    if (!downloadUrl) {
      status(`Download URI is not ready yet. Waiting ${JSON.stringify(body, null, 2)}`)
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }

  //
  // Download
  //
  const roDownload = {
    uri: downloadUrl,
    method: 'GET',
    json: true,
    transform: (body, response) => ({
      response,
      body
    })
  }
  status(`Constructed requestOptions for download: ${JSON.stringify(roDownload, null, 2)}`)

  const { body: dlBody, response: dlResponse } = await rp(roDownload)
  if (dlResponse.statusCode >= 400) {
    status(`got error response for download: ${response.statusCode}/${response.statusMessage}`)
    throw new Error(`got error response for download: ${response.statusCode}/${response.statusMessage}`)
  }

  return dlBody
}

const importKoreaiIntents = async ({ caps, importallutterances, buildconvos }, { statusCallback }) => {
  const driver = new BotDriver(getCaps(caps))
  const container = await driver.Build()
  // required for token
  await container.Start()
  const chatbotData = await getContent({ container, statusCallback })

  const utterances = {}

  for (const entry of chatbotData) {
    if (importallutterances || entry.type === 'DialogIntent') {
      if (!utterances[entry.taskName]) {
        utterances[entry.taskName] = {
          name: entry.taskName,
          utterances: []
        }
      }
      utterances[entry.taskName].utterances.push(entry.sentence)
    }
  }

  const convos = []
  if (buildconvos) {
    for (const utterance of Object.values(utterances)) {
      const convo = {
        header: {
          name: utterance.name
        },
        conversation: [
          {
            sender: 'me',
            messageText: utterance.name
          },
          {
            sender: 'bot',
            asserters: [
              {
                name: 'INTENT',
                args: [utterance.name]
              }
            ]
          }
        ]
      }
      convos.push(convo)
    }
  }

  return {
    utterances: Object.values(utterances)
  }
}

const exportKoreaiIntents = async ({ caps, uploadmode }, { utterances }, { statusCallback }) => {
  const status = (log, obj) => {
    debug(log, obj)
    if (statusCallback) statusCallback(log, obj)
  }
  const driver = new BotDriver(getCaps(caps))
  const container = await driver.Build()
  // required for token
  await container.Start()
  let newData = null
  if (uploadmode === 'append') {
    newData = await getContent({ container })
  } else {
    newData = []
  }

  for (const struct of utterances) {
    for (const utterance of struct.utterances) {
      if (!newData.find(old => old.taskName === struct.name && old.sentence === utterance)) {
        newData.push({
          taskName: struct.name,
          sentence: utterance,
          type: 'DialogIntent'
          // TODO
          // entities: [],
          // language: 'en'
        })
      }
    }
  }

  const { urlRoot, botId } = extractUrl(container)

  const roUpload = {
    uri: `${urlRoot}/uploadfile`,
    method: 'POST',
    headers: {
      auth: `${container.pluginInstance.token}`,
      'Content-Type': 'multipart/form-data'
    },
    formData: {
      file: JSON.stringify(newData),
      fileContent: 'bulkImport',
      fileExtension: 'json'
    },
    transform: (body, response) => ({
      response,
      body
    })
  }

  // TODO
  console.log(`roUpload ===> ${JSON.stringify(roUpload)}`)
  const { body: uBody, response: uResponse } = await rp(roUpload)
  if (uResponse.statusCode >= 400) {
    status(`got error response for uploadfile: ${uResponse.statusCode}/${uResponse.statusMessage}`)
    throw new Error(`got error response for uploadfile: ${uResponse.statusCode}/${uResponse.statusMessage}`)
  }

  if (uBody.fileId) {
    status(`fileId not found in uploadfile response: ${JSON.stringify(uBody)}`)
    throw new Error(`fileId not found in uploadfile response: ${JSON.stringify(uBody)}`)
  }
  const roImport = {
    uri: `${urlRoot}/bot/${botId}/mlimport`,
    method: 'POST',
    headers: {
      auth: `${container.pluginInstance.token}`
    },
    body: {
      fileName: 'filename',
      fileID: uBody.fileId
    },
    transform: (body, response) => ({
      response,
      body
    })
  }

  const { body: iBody, response: iResponse } = await rp(roImport)

  if (iResponse.statusCode >= 400) {
    status(`got error response for uploadfile: ${uResponse.statusCode}/${uResponse.statusMessage}`)
    throw new Error(`got error response for mlimport: ${uResponse.statusCode}/${uResponse.statusMessage}`)
  }

  // TODO
  console.log(`iBody ===> ${JSON.stringify(iBody)}`)
}

module.exports = {
  importHandler: ({ caps, importallutterances, buildconvos, ...rest } = {}, { statusCallback } = {}) => importKoreaiIntents({ caps, importallutterances, buildconvos, ...rest }, { statusCallback }),
  importArgs: {
    caps: {
      describe: 'Capabilities',
      type: 'json',
      skipCli: true
    },
    importallutterances: {
      describe: 'Import all utterances as intents. Not just DialogIntents',
      type: 'boolean',
      default: false
    },
    buildconvos: {
      describe: 'Build convo files for intent assertions (otherwise, just write utterances files)',
      type: 'boolean',
      default: false
    }
  },
  exportHandler: ({ caps, uploadmode, ...rest } = {}, { convos, utterances } = {}, { statusCallback } = {}) => exportKoreaiIntents({ caps, uploadmode, ...rest }, { convos, utterances }, { statusCallback }),
  exportArgs: {
    caps: {
      describe: 'Capabilities',
      type: 'json',
      skipCli: true
    },
    uploadmode: {
      describe: 'Appending API intents and user examples or replace them',
      choices: ['append', 'replace'],
      default: 'append'
    }
  }
}
