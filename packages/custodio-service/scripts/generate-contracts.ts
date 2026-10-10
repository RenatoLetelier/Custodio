import { readFileSync, writeFileSync } from 'node:fs'
import { EVENTS_FILE, OPENAPI_FILE, eventsMarkdown, openApiYaml } from '../src/api/contracts-files.js'

writeFileSync(OPENAPI_FILE, openApiYaml())
writeFileSync(EVENTS_FILE, eventsMarkdown(readFileSync(EVENTS_FILE, 'utf8')))
console.log(`Escrito ${OPENAPI_FILE}\nActualizado ${EVENTS_FILE}`)
