const PluginClass = require('./src/connector')

module.exports = {
  PluginVersion: 1,
  PluginClass: PluginClass,
  PluginDesc: {
    name: 'Kore.ai',
    provider: 'Kore.ai',
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
