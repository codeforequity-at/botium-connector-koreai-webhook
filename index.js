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
      testCaseGeneration: true
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
      }
    ]
  }
}
