# Botium Connector for Kore.ai Webhooks 

[![NPM](https://nodei.co/npm/botium-connector-koreai-webhook.png?downloads=true&downloadRank=true&stars=true)](https://nodei.co/npm/botium-connector-koreai-webhook/)

[![Codeship Status for codeforequity-at/botium-connector-koreai-webhook](https://app.codeship.com/projects/913b9260-f570-0136-2f32-1e71af04627f/status?branch=master)](https://app.codeship.com/projects/320855)
[![npm version](https://badge.fury.io/js/botium-connector-koreai-webhook.svg)](https://badge.fury.io/js/botium-connector-koreai-webhook)
[![license](https://img.shields.io/github/license/mashape/apistatus.svg)]()

This is a [Botium](https://github.com/codeforequity-at/botium-core) connector for testing your Kore.ai chatbot.

__Did you read the [Botium in a Nutshell](https://medium.com/@floriantreml/botium-in-a-nutshell-part-1-overview-f8d0ceaf8fb4) articles ? Be warned, without prior knowledge of Botium you won't be able to properly use this library!__

## How it works ?
Botium uses a [Kore.ai Webhook channel](https://developer.kore.ai/docs/bots/bot-builder/adding-channels-to-your-bot/adding-webhook-channel/) to connect to your chatbot.

It can be used as any other Botium connector with all Botium Stack components:
* [Botium CLI](https://github.com/codeforequity-at/botium-cli/)
* [Botium Bindings](https://github.com/codeforequity-at/botium-bindings/)
* [Botium Box](https://www.botium.at)

## Requirements

* __Node.js and NPM__
* a __Kore.ai chatbot with [Webhook channel](https://developer.kore.ai/docs/bots/bot-builder/adding-channels-to-your-bot/adding-webhook-channel/) enabled__
* a __project directory__ on your workstation to hold test cases and Botium configuration

## Install Botium and Kore.ai Webhook Connector

When using __Botium CLI__:

```
> npm install -g botium-cli
> npm install -g botium-connector-koreai-webhook
> botium-cli init
> botium-cli run
```

When using __Botium Bindings__:

```
> npm install -g botium-bindings
> npm install -g botium-connector-koreai-webhook
> botium-bindings init mocha
> npm install && npm run mocha
```

When using __Botium Box__:

_Already integrated into Botium Box, no setup required_

## Connecting your Kore.ai chatbot to Botium

You have to attach a _Webhook channel_ to your Kore.ai chatbot:
1. Follow the [instructions](https://developer.kore.ai/docs/bots/bot-builder/adding-channels-to-your-bot/adding-webhook-channel/)
2. From the Webhook configuration screen, copy those settings to the _botium.json_ file:
    1. CLIENT ID
    2. CLIENT SECRET
    3. Webhook URL
3. Don't forget to __publish__ the webhook

Open the file _botium.json_ in your working directory and add the Webhook settings.

```
{
  "botium": {
    "Capabilities": {
      "PROJECTNAME": "<whatever>",
      "CONTAINERMODE": "koreai-webhook",
      "KOREAI_WEBHOOK_URL": "https://bots.kore.ai/chatbot/hooks/...",
      "KOREAI_WEBHOOK_CLIENTID": "...",
      "KOREAI_WEBHOOK_CLIENTSECRET": "..."
    }
  }
}
```
Botium setup is ready, you can begin to write your [BotiumScript](https://github.com/codeforequity-at/botium-core/wiki/Botium-Scripting) files.

## Supported Capabilities

Set the capability __CONTAINERMODE__ to __koreai-webhook__ to activate this connector.

### KOREAI_WEBHOOK_URL
The full Webhook URL from the Webhook configuration settings

### KOREAI_WEBHOOK_CLIENTID
The CLIENT ID from the Webhook configuration settings

### KOREAI_WEBHOOK_CLIENTSECRET
The CLIENT SECRET from the Webhook configuration settings

_It is recommended to actually not add this to the botium.json file, but to use the environment variable BOTIUM_KOREAI_WEBHOOK_CLIENTSECRET instead_

### KOREAI_WEBHOOK_FROMID
If set, this userId will be used as sender. Otherwise, for each convo a new userId is generated.

### KOREAI_WEBHOOK_TOID
If set, this userId will be used as receiver. Otherwise, for each convo a new userId is generated.

## Open Issues and Restrictions
* Currently only text messages supported
