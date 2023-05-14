const Connector = require('./connector')
const debug = () => require('debug')('botium-connector-koreai-intents')
const axios = require('axios')
const FormData = require('form-data')
const uuidv1 = require('uuid').v1
const https = require('https')
const { URL } = require('url')

const Capabilities = require('./Capabilities')

const extractUrl = (container) => {
  const uriWebhook = container.caps[Capabilities.KOREAI_WEBHOOK_URL]
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
    const url = new URL(urlRoot)
    return { urlRoot, botId, hostname: url.hostname, pathname: url.pathname }
  }
}

const getContent = async ({ container, statusCallback }) => {
  const status = (log, obj) => {
    obj ? debug(log, obj) : debug(log)
    if (statusCallback) statusCallback(log, obj)
  }

  const urlStruct = extractUrl(container)
  const { urlRoot, botId } = urlStruct

  //
  // Start download
  //
  try {
    const roStart = {
      url: `${urlRoot}/bot/${botId}/mlexport?state=configured&=&type=json`,
      method: 'POST',
      headers: {
        auth: `${container.token}`
      }
    }
    debug(`Constructed requestOptions for mlexport: ${JSON.stringify(roStart, null, 2)}`)
    const resStart = await axios(roStart)
    const streamId = resStart.data.streamId
    status('Import started')

    //
    // Checking download status
    //
    const roStatus = {
      url: `${urlRoot}/bot/${streamId}/mlexport/status`,
      method: 'GET',
      headers: {
        auth: `${container.token}`
      }
    }
    debug(`Constructed requestOptions for mlexport/status: ${JSON.stringify(roStatus, null, 2)}`)
    let exportFinished = false
    let resStatus = null

    for (let tries = 0; tries < 20 && !exportFinished; tries++) {
      try {
        resStatus = (await axios(roStatus)).data
        // Some other state to check?
        exportFinished = ['FAILED', 'SUCCESS'].includes(resStatus.status)
        if (!exportFinished) {
          status(`Import state is "${resStatus.status}". Waiting 1s`)
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      } catch (err) {
      // i get sometimes internal server error on first try, but on second try it is working.
      // To be sure retry is for all errors, and not just for the first try
        status(`Error from mlexport/status: ${err.message || err} retrying`)
      }
    }

    if (!resStatus || resStatus.status !== 'SUCCESS') {
      throw new Error(`Import failed ${JSON.stringify(resStatus, null, 2)}`)
    }

    status('Import finished')

    //
    // Download
    //
    const roDownload = {
      url: resStatus.downloadUrl,
      method: 'GET'
    }
    debug(`Constructed requestOptions for download: ${JSON.stringify(roDownload, null, 2)}`)

    const resDownload = await axios(roDownload)

    status('Import file downloaded')

    return resDownload.data
  } catch (err) {
    if (err.isAxiosError) {
      throw new Error(`failed to call endpoint "${err.config?.url}" error message "${err.message}"`)
    }
    throw err
  }
}

const importKoreaiIntents = async ({ caps, importallutterances, buildconvos }, { statusCallback }) => {
  const container = new Connector({ caps })
  await container.Start()
  const chatbotData = await getContent({ container, statusCallback })

  const utterances = {}

  for (const entry of chatbotData) {
    if (importallutterances || entry.type === 'DialogIntent') {
      if (!utterances[entry.taskName]) {
        utterances[entry.taskName] = {
          name: entry.taskName,
          utterances: entry.taskName !== entry.sentence ? [entry.taskName] : []
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
    convos,
    utterances: Object.values(utterances)
  }
}

const exportKoreaiIntents = async ({ caps, language = 'en' }, { utterances }, { statusCallback }) => {
  try {
    const status = (log, obj) => {
      if (obj) {
        debug(log, obj)
      } else {
        debug(log)
      }
      if (statusCallback) statusCallback(log, obj)
    }
    const container = new Connector({ caps })
    await container.Start()
    const adminToken = container.adminToken
    if (!adminToken) {
      throw new Error('Admin token is not available, check admin credentials!')
    }

    status(`Import started`)
    const newData = await getContent({ container, statusCallback })

    const existingIntents = new Set(newData.map(s => s.taskName))
    status(`Chatbot data imported. (${newData.length} utterances in ${existingIntents.size} intents)`)

    let added = 0
    for (const struct of utterances) {
      if (!existingIntents.has(struct.name)) {
        status(`Skipping intent "${struct.name}" because it does not exist in the Chatbot`)
      } else {
        for (const utterance of struct.utterances) {
          if (!newData.find(old => old.taskName === struct.name && old.sentence === utterance)) {
            added++
            newData.push({
              taskName: struct.name,
              sentence: utterance,
              type: 'DialogIntent',
              language: language
            })
          }
        }
      }
    }

    if (!added) {
      status(`No utterance added to data, noting to export. Exiting.`)
      return
    } else {
      status(`Adding ${added} utterance(s) to exported data`)
    }

    const urlStruct = extractUrl(container)
    const { urlRoot, botId } = urlStruct

    const fileName = `BotiumUtterances${uuidv1()}.json`
    const data = new FormData()
    data.append('file', Buffer.from(JSON.stringify(newData), 'utf-8'), fileName)
    data.append('fileContext', 'bulkImport')
    data.append('fileExtension', 'json')
    const roUpload = {
      url: `${urlRoot}/uploadfile`,
      method: 'POST',
      headers: {
        auth: `${adminToken}`
      },
      data: data
    }
    debug(`Constructed requestOptions for uploadfile: ${JSON.stringify(Object.assign({}, roUpload, { data: '...' }), null, 2)}`)
    const resUpload = await axios(roUpload)
    if (!resUpload.data || !resUpload.data.fileId) {
      status(`fileId not found in uploadfile response: ${JSON.stringify(resUpload.data)}`)
      throw new Error(`fileId not found in uploadfile response: ${JSON.stringify(resUpload.data)}`)
    }
    status('Export started')

    const resImport = await koreaiImportEndpointNative({ container, urlStruct, fileName, fileId: resUpload.data.fileId })

    const roStatus = {
      url: `${urlRoot}/bot/${botId}/mlimport/status/${resImport._id}`,
      method: 'GET',
      headers: {
        auth: `${container.token}`
      }
    }
    debug(`Constructed requestOptions for mlexport/status: ${JSON.stringify(roStatus, null, 2)}`)
    let importFinished = false
    let resStatus

    for (let tries = 0; tries < 20 && !importFinished; tries++) {
      try {
        resStatus = (await axios(roStatus)).data
        // Some other state to check?
        importFinished = ['failed', 'success'].includes(resStatus.status)
        if (!importFinished) {
          status(`Export state is "${resStatus.status}". Waiting 1s`)
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      } catch (err) {
      // i get sometimes internal server error on first try, but on second try it is working.
      // To be sure retry is for all errors, and not just for the first try
        status(`Error from mlexport/status: ${err.message || err} retrying`)
      }
    }
    if (resStatus.status !== 'success') {
      throw new Error(`Export failed ${JSON.stringify(resStatus, null, 2)}`)
    }

    status(`File exported to KoreAI successful: ${resStatus.message}`)
  } catch (err) {
    if (err.isAxiosError) {
      throw new Error(`failed to call endpoint "${err.config?.url}" error message "${err.message}"`)
    }
    throw err
  }
}

/**
 *
 * @returns {Promise<void>}í
 * Does not work with axios somehow. I get 412 error code. But with reqest, and native nodejs it works.
 *   const roImport = {
    url: `${urlRoot}/bot/${botId}/mlimport`,
    method: 'POST',
    headers: {
      auth: `${container.token}`
    },
    data: {
      fileName: FILENAME,
      fileID: resUpload.data.fileId
    }
  }
 */
const koreaiImportEndpointNative = async ({ container, urlStruct, fileName, fileId }) => {
  return new Promise((resolve, reject) => {
    const options = {
      method: 'POST',
      hostname: urlStruct.hostname,
      path: `${urlStruct.pathname}/bot/${urlStruct.botId}/mlimport`,
      headers: {
        auth: `${container.token}`,
        'content-type': 'application/json'
      },
      maxRedirects: 20
    }

    const req = https.request(options, (res) => {
      const chunks = []

      res.on('data', function (chunk) {
        chunks.push(chunk)
      })

      res.on('end', function () {
        const body = Buffer.concat(chunks)
        if (res.statusCode < 400) {
          resolve(JSON.parse(body))
        } else {
          reject(new Error(`Request failed with error code ${res.statusCode} response: ${body}`))
        }
      })

      res.on('error', function (error) {
        reject(error)
      })
    })

    const postData = JSON.stringify({
      fileName,
      fileId
    })

    req.write(postData)

    req.end()
  })
}

module.exports = {
  axios,
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
  exportHandler: ({ caps, language, ...rest } = {}, { convos, utterances } = {}, { statusCallback } = {}) => exportKoreaiIntents({ caps, language, ...rest }, { convos, utterances }, { statusCallback }),
  exportArgs: {
    caps: {
      describe: 'Capabilities',
      type: 'json',
      skipCli: true
    },
    language: {
      describe: 'The language of the data (like "en")',
      type: 'string',
      default: 'en'
    }
  }
}
