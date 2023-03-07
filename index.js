const PluginClass = require('./src/connector')
const { importHandler, importArgs } = require('./src/intents')

module.exports = {
  PluginVersion: 1,
  PluginClass: PluginClass,
  Import: {
    Handler: importHandler,
    Args: importArgs
  },
  PluginDesc: {
    name: 'Kore.ai',
    provider: 'Kore.ai',
    features: {
      intentResolution: true,
      entityResolution: true,
      testCaseGeneration: true,
      testCaseExport: true
    },
    capabilities: [
      {
        name: 'KOREAI_WEBHOOK_URL',
        label: 'Webhook URL',
        type: 'string',
        required: true
      },
      {
        name: 'KOREAI_WEBHOOK_CLIENTID',
        label: 'Client ID',
        type: 'string',
        required: true
      },
      {
        name: 'KOREAI_WEBHOOK_CLIENTSECRET',
        label: 'Client Secret',
        type: 'secret',
        required: true
      },
      {
        name: 'KOREAI_WEBHOOK_NLP_ANALYTICS_ENABLE',
        label: 'Extract NLP metadata (Required for Botium Coach)',
        description: 'NLP Analytics is an extra call. Its slowing down the test',
        type: 'boolean',
        required: true
      },
      {
        name: 'KOREAI_WEBHOOK_NLP_ANALYTICS_URL',
        label: 'NLP Analytics url',
        type: 'string',
        advanced: true
      },
      {
        name: 'KOREAI_WEBHOOK_BOTNAME',
        label: 'The name of the Bot (Required if NLP Analytics is enabled)',
        type: 'string',
        required: false
      },
      {
        name: 'KOREAI_WEBHOOK_FROMID',
        label: 'UserId of sender',
        type: 'string',
        advanced: true
      },
      {
        name: 'KOREAI_WEBHOOK_TOID',
        label: 'UserId of receiver',
        type: 'string',
        advanced: true
      },
      {
        name: 'KOREAI_WEBHOOK_ADMIN_CLIENTID',
        label: 'Admin client ID (Required for uploading training data to a Bot)',
        type: 'string',
        advanced: true
      },
      {
        name: 'KOREAI_WEBHOOK_ADMIN_CLIENTSECRET',
        label: 'Admin client secret (Required for uploading training data to a Bot)',
        type: 'secret',
        advanced: true
      }
    ]
  }
}
