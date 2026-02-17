const Connector = require('./connector')
const debug = require('debug')('botium-connector-koreai-intents')
const FormData = require('form-data')

const uuidv1 = require('uuid').v1
const https = require('https')

const Capabilities = require('./Capabilities')

const _errMsg = (err) => (err && err.message) ? err.message : String(err)
const _errDetails = (err) => {
  const fmt = (e) => {
    if (!e) return 'n/a'
    const parts = []
    if (e.name) parts.push(`name=${e.name}`)
    if (e.message) parts.push(`message=${JSON.stringify(e.message)}`)
    if (e.code) parts.push(`code=${e.code}`)
    if (e.errno) parts.push(`errno=${e.errno}`)
    if (e.syscall) parts.push(`syscall=${e.syscall}`)
    if (e.hostname) parts.push(`hostname=${e.hostname}`)
    if (e.address) parts.push(`address=${e.address}`)
    if (e.port) parts.push(`port=${e.port}`)
    return parts.length > 0 ? parts.join(' ') : String(e)
  }

  const out = [fmt(err)]
  // Node fetch (undici) frequently stores the real network/TLS error in `cause`
  if (err && err.cause) {
    out.push(`cause=[${fmt(err.cause)}]`)
    if (err.cause && err.cause.cause && err.cause.cause !== err.cause) {
      out.push(`cause2=[${fmt(err.cause.cause)}]`)
    }
  }
  return out.join(' ')
}
const _safeJson = (obj) => {
  try {
    return JSON.stringify(obj, null, 2)
  } catch (e) {
    return String(obj)
  }
}
const _tryReadBody = async (res) => {
  try {
    return await res.text()
  } catch (e) {
    return ''
  }
}

const extractUrl = (container) => {
  if (container.caps[Capabilities.KOREAI_WEBHOOK_BOTID] && container.caps[Capabilities.KOREAI_WEBHOOK_BASE_URL]) {
    const urlRoot = container.caps[Capabilities.KOREAI_WEBHOOK_BASE_URL]
    const botId = container.caps[Capabilities.KOREAI_WEBHOOK_BOTID]
    return { urlRoot: urlRoot + '/api/public', botId }
  }
  // all this are legacy. KOREAI_WEBHOOK_BOTID and KOREAI_WEBHOOK_BASE_URL are mandatory now.
  const uriWebhook = container.caps[Capabilities.KOREAI_WEBHOOK_URL]
  if (uriWebhook.indexOf('/chatbot/hooks/') >= 0) {
    const normalizedUri = uriWebhook.indexOf('/hookInstance/') > 0
      ? uriWebhook.substring(0, uriWebhook.indexOf('/hookInstance/'))
      : uriWebhook
    const splitted = normalizedUri.split('/chatbot/hooks/')
    if (splitted.length !== 2) {
      throw new Error(`Webhook URL (Plain) ${uriWebhook} is not valid, download failed`)
    }
    const urlRoot = splitted[0].concat('/api/public')
    const botId = splitted[1]
    return { urlRoot, botId }
  } else if (uriWebhook.indexOf('/ivr/hooks/') >= 0) {
    const normalizedUri = uriWebhook.indexOf('/hookInstance/') > 0
      ? uriWebhook.substring(0, uriWebhook.indexOf('/hookInstance/'))
      : uriWebhook
    const splitted = normalizedUri.split('/ivr/hooks/')
    if (splitted.length !== 2) {
      throw new Error(`Webhook URL (IVR) ${uriWebhook} is not valid, download failed`)
    }
    const urlRoot = splitted[0].concat('/api/public')
    const botId = splitted[1]
    return { urlRoot, botId }
  } else {
    throw new Error(`Webhook URL ${uriWebhook} is not valid, download failed`)
  }
}

const getUtterances = async ({ token, statusCallback, status, botId, botName, urlRoot }) => {
  status = status || ((log, obj) => {
    obj ? debug(log, obj) : debug(log)
    if (statusCallback) statusCallback(log, obj)
  })

  const maxTries = 20
  const retryDelayMs = 1000
  let lastRequest = null

  //
  // Start download
  //
  try {
    const roStart = {
      url: `${urlRoot}/bot/${botId}/mlexport?state=configured&=&type=json`,
      method: 'POST',
      headers: {
        auth: `${token}`,
        'Content-Type': 'application/json'
      }
    }
    debug(`Constructed requestOptions for mlexport: ${JSON.stringify(roStart, null, 2)}`)
    lastRequest = { step: 'mlexport start', method: roStart.method, url: roStart.url }
    const resStart = await fetch(roStart.url, {
      method: roStart.method,
      headers: roStart.headers,
      ...(roStart.data && { body: JSON.stringify(roStart.data) })
    })

    if (!resStart.ok) {
      const body = await _tryReadBody(resStart)
      throw new Error(`getUtterances: mlexport start failed (${resStart.status}) ${roStart.method} ${roStart.url}${body ? ` - ${body}` : ''}`)
    }

    const resStartData = await resStart.json()
    const streamId = resStartData.streamId
    debug(`Export started for bot ${botName || 'main'}(${botId || 'main'})`)
    //
    // Checking download status
    //
    const roStatus = {
      url: `${urlRoot}/bot/${streamId}/mlexport/status`,
      method: 'GET',
      headers: {
        auth: `${token}`
      }
    }
    debug(`Constructed requestOptions for mlexport/status: ${JSON.stringify(roStatus, null, 2)}`)
    let exportFinished = false
    let resStatus = null

    for (let tries = 0; tries < maxTries && !exportFinished; tries++) {
      try {
        lastRequest = { step: 'mlexport status', method: roStatus.method, url: roStatus.url }
        const resStatusData = await fetch(roStatus.url, {
          method: roStatus.method,
          headers: roStatus.headers
        })

        if (!resStatusData.ok) {
          const body = await _tryReadBody(resStatusData)
          throw new Error(`getUtterances: mlexport/status failed (${resStatusData.status}) ${roStatus.method} ${roStatus.url}${body ? ` - ${body}` : ''}`)
        }

        resStatus = await resStatusData.json()
        // Some other state to check?
        exportFinished = ['FAILED', 'SUCCESS'].includes(resStatus.status)
        if (!exportFinished) {
          debug(`Export state is "${resStatus.status}". Waiting 1s`)
          await new Promise(resolve => setTimeout(resolve, retryDelayMs))
        }
      } catch (err) {
      // i get sometimes internal server error on first try, but on second try it is working.
      // To be sure retry is for all errors, and not just for the first try
        if (tries !== (maxTries - 1)) {
          status(`Error from mlexport/status: ${_errDetails(err)} retrying`)
        } else {
          throw new Error(`getUtterances: export failed, mlexport/status try #${maxTries} failed with error "${_errMsg(err)}" (${roStatus.method} ${roStatus.url})`)
        }
      }
    }

    if (!resStatus || resStatus.status !== 'SUCCESS') {
      const statusValue = resStatus && resStatus.status
      const reason = !exportFinished
        ? `timed out waiting for export to finish after ${maxTries} tries`
        : `export finished with status "${statusValue}"`
      throw new Error(`getUtterances: ${reason} (${roStatus.method} ${roStatus.url}) lastResponse=${_safeJson(resStatus)}`)
    }

    debug(`Export finished for bot ${botName || 'main'}(${botId || 'main'})`)

    //
    // Download
    //
    const roDownload = {
      url: resStatus.downloadUrl,
      method: 'GET'
    }
    debug(`Constructed requestOptions for download: ${JSON.stringify(roDownload, null, 2)}`)

    lastRequest = { step: 'mlexport download', method: roDownload.method, url: roDownload.url }
    const resDownloadData = await fetch(roDownload.url, {
      method: roDownload.method
    })

    if (!resDownloadData.ok) {
      throw new Error(`Failed to download import file, status code ${resDownloadData.status}`)
    }

    const resDownload = await resDownloadData.json()

    debug(`Export file downloaded for bot ${botName || 'main'}(${botId || 'main'})`)

    return resDownload
  } catch (err) {
    const lr = lastRequest ? ` (step=${lastRequest.step} ${lastRequest.method} ${lastRequest.url})` : ''
    throw new Error(`getUtterances failed: ${_errDetails(err)}${lr}`, { cause: err })
  }
}

const getLinkedApps = async ({ token, status, botId, botName, urlRoot, language = 'en' }) => {
  try {
    // extractUrl() returns "<base>/api/public" - for this endpoint we need "<base>/api/1.1/public"
    const apiPublicSuffix = '/api/public'
    const baseUrl = urlRoot && urlRoot.endsWith(apiPublicSuffix)
      ? urlRoot.slice(0, -apiPublicSuffix.length)
      : urlRoot
    const linkedAppsUrlRoot = `${baseUrl}/api/1.1/public`

    // Request options for fetching linked apps from the universalbot/link endpoint
    const roLinkedApps = {
      url: `${linkedAppsUrlRoot}/bot/${botId}/universalbot/link?language=${language}`,
      method: 'GET',
      headers: {
        auth: `${token}`,
        Accept: 'application/json',
        'bot-language': language,
        'app-language': language,
        'client-app': 'unified'
      }
    }
    debug(`Constructed requestOptions for universalbot/link: ${JSON.stringify(roLinkedApps, null, 2)}`)

    const resLinkedApps = await fetch(roLinkedApps.url, {
      method: roLinkedApps.method,
      headers: roLinkedApps.headers
    })

    if (!resLinkedApps.ok) {
      const body = await _tryReadBody(resLinkedApps)
      throw new Error(`getLinkedApps: universalbot/link failed (${resLinkedApps.status}) ${roLinkedApps.method} ${roLinkedApps.url}${body ? ` - ${body}` : ''}`)
    }
    const resLinkedAppsData = await resLinkedApps.json()
    const publishedBots = resLinkedAppsData?.publishedBots || []
    status(`Fetched ${Array.isArray(publishedBots) ? publishedBots.length : 0} linked apps for bot ${botName || 'main'}(${botId || 'main'}).`)
    return Array.isArray(publishedBots) ? publishedBots : []
  } catch (err) {
    throw new Error(`getLinkedApps failed: ${_errDetails(err)} (botId=${botId || 'main'})`, { cause: err })
  }
}

const importKoreaiIntents = async ({ caps, importallutterances, buildconvos }, { statusCallback }) => {
  const status = (log, obj) => {
    obj ? debug(log, obj) : debug(log)
    if (statusCallback) statusCallback(log, obj)
  }
  const container = new Connector({ caps })
  const chatbotToken = container.createToken(null, null, true)
  const adminToken = container.createAdminToken(true)
  const botName = container.caps[Capabilities.KOREAI_WEBHOOK_BOTNAME] || 'main'

  const urlStruct = extractUrl(container)
  const { urlRoot, botId } = urlStruct

  const utterances = {}
  const visitedBotIds = new Set()
  const importKoreaiIntentsRecursive = async ({ botId, botName, urlRoot }) => {
    // Prevent infinite recursion by tracking visited bot IDs
    if (visitedBotIds.has(botId)) {
      debug(`Bot ${botName || 'main'}(${botId || 'main'}) already visited, skipping to prevent circular references.`)
      return
    }
    visitedBotIds.add(botId)

    const chatbotData = await getUtterances({ token: adminToken || chatbotToken, status, botId, botName, urlRoot })
    let utteranceBatchCount = 0
    for (const entry of chatbotData) {
      if ((importallutterances || entry.type === 'DialogIntent') && entry.taskName) {
        if (!utterances[entry.taskName]) {
          utterances[entry.taskName] = {
            name: entry.taskName,
            utterances: entry.taskName !== entry.sentence ? [entry.taskName] : []
          }
        }
        utterances[entry.taskName].utterances.push(entry.sentence)
        utteranceBatchCount++
      }
    }

    status(`Imported ${utteranceBatchCount} utterances from bot ${botName || 'main'}(${botId || 'main'})`)

    if (adminToken) {
      try {
        const linkedApps = await getLinkedApps({ token: adminToken, statusCallback, status, botId, botName, urlRoot })
        if (linkedApps && linkedApps.length) {
          for (const linkedApp of linkedApps) {
            const rawLinkedBotId = linkedApp?._id || linkedApp?.botId || linkedApp?.id
            const linkedBotId = (rawLinkedBotId && typeof rawLinkedBotId === 'string' && !rawLinkedBotId.startsWith('st-'))
              ? `st-${rawLinkedBotId}`
              : rawLinkedBotId
            if (!linkedBotId) {
              status(`Bot ${botName || 'main'}(${botId || 'main'}) has linked app ${linkedApp?.name || linkedApp?.botName || 'main'} with missing bot id. Skipping utterance download for this linked app.`)
              continue
            }
            status(`Bot ${botName || 'main'}(${botId || 'main'}) has linked app ${linkedApp?.name || linkedApp?.botName || 'main'}(${linkedBotId || 'main'}). Downloading utterances from it.`)
            await importKoreaiIntentsRecursive({ botId: linkedBotId, botName: linkedApp?.name || linkedApp?.botName, urlRoot })
          }
        } else {
          debug(`No linked apps found for bot ${botName || 'main'}(${botId || 'main'}).`)
        }
      } catch (err) {
        status(`Linked apps fetch failed for bot ${botName || 'main'}(${botId || 'main'}). (ignored). Downloaded from LinkedBots not possible.`, { error: _errMsg(err) })
      }
    } else {
      status(`Skipping linked bots for bot ${botName || 'main'}(${botId || 'main'}) because no admin token present`)
    }
  }

  await importKoreaiIntentsRecursive({ botId, botName, urlRoot })
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

  const res = { utterances: Object.values(utterances) }
  if (convos && convos.length) {
    res.convos = convos
  }
  return res
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
    const token = container.createToken(null, null, true)
    const adminToken = container.createAdminToken(true)
    if (!adminToken) {
      throw new Error('Admin token is not available, check admin credentials!')
    }

    const botName = container.caps[Capabilities.KOREAI_WEBHOOK_BOTNAME]
    if (!botName) {
      throw new Error('Bot name is not available!')
    }
    const urlStruct = extractUrl(container)
    status('Export started ')
    const newData = await getUtterances({ token, status, botId: urlStruct.botId, botName, urlRoot: urlStruct.urlRoot })

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
      status('No utterance added to data, noting to export. Exiting.')
      return
    } else {
      status(`Adding ${added} utterance(s) to exported data`)
    }

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
        auth: `${adminToken}`,
        'Content-Type': 'multipart/form-data'
      },
      data: data
    }
    debug(`Constructed requestOptions for uploadfile: ${JSON.stringify(Object.assign({}, roUpload, { data: '...' }), null, 2)}`)
    const resUploadData = await fetch(roUpload.url, {
      method: roUpload.method,
      headers: roUpload.headers,
      ...(roUpload.data && { body: roUpload.data })
    })

    if (!resUploadData.ok) {
      throw new Error(`Failed to upload file, status code ${resUploadData.status}`)
    }

    const resUpload = await resUploadData.json()
    if (!resUpload || !resUpload.fileId) {
      status(`fileId not found in uploadfile response: ${JSON.stringify(resUpload)}`)
      throw new Error(`fileId not found in uploadfile response: ${JSON.stringify(resUpload)}`)
    }
    status('Export started')

    const resImport = await koreaiImportEndpointNative({ token, urlStruct, fileName, fileId: resUpload.fileId })

    const roStatus = {
      url: `${urlRoot}/bot/${botId}/mlimport/status/${resImport._id}`,
      method: 'GET',
      headers: {
        auth: `${token}`
      }
    }
    debug(`Constructed requestOptions for mlexport/status: ${JSON.stringify(roStatus, null, 2)}`)
    let importFinished = false
    let resStatus

    for (let tries = 0; tries < 20 && !importFinished; tries++) {
      try {
        const resStatusData = await fetch(roStatus.url, {
          method: roStatus.method,
          headers: roStatus.headers
        })

        if (!resStatusData.ok) {
          throw new Error(`Failed to get export status, status code ${resStatusData.status}`)
        }

        resStatus = await resStatusData.json()
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
    throw new Error(`exportKoreaiIntents failed: ${_errMsg(err)}`, { cause: err })
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
const koreaiImportEndpointNative = async ({ token, urlStruct, fileName, fileId }) => {
  return new Promise((resolve, reject) => {
    const options = {
      method: 'POST',
      hostname: urlStruct.hostname,
      path: `${urlStruct.pathname}/bot/${urlStruct.botId}/mlimport`,
      headers: {
        auth: `${token}`,
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
