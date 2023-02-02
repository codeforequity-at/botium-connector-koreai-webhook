const { importHandler } = require('./intents')

const botiumJSON = require('./botium.local.json')
importHandler(
  {
    caps: botiumJSON.botium.Capabilities,
    buildconvos: true
  }, {
    statusCallback: (log, obj) => obj ? console.log(log, obj) : console.log(log)
  })
  .then(result => console.log(`result ===> ${JSON.stringify(result, null, 2)}`))
  .catch(err => // TODO
    console.log(`err ===> ${err}`))
