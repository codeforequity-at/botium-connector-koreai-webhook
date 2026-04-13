import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const readCaps = () => {
  // botium caps should come from env variable (.env) or botium.json. Priority is not defined if both are filled
  let botiumJson
  try {
    botiumJson = JSON.parse(readFileSync(join(__dirname, 'botium.json'), 'utf8'))
  } catch (err) {
  }
  const caps = botiumJson?.botium.Capabilities || {}
  Object.keys(process.env).filter(e => e.startsWith('BOTIUM_')).forEach((element) => {
    const elementToMerge = element.replace(/^BOTIUM_/, '')
    caps[elementToMerge] = process.env[element]
  })

  return caps
}
