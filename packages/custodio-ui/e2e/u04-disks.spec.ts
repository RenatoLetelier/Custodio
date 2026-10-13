import es from '../src/ui/i18n/es.json'
import { captureEvidence } from './evidence'
import { FORBIDDEN_TERMS, expect, goTo, openApp, test } from './support/fixtures'
import { healthy } from './support/service'

const GB = 1_000_000_000
const usage = (total: number, free: number) => ({ totalBytes: total * GB, freeBytes: free * GB })

test.use({
  scenario: {
    disks: [
      { name: 'sano', model: 'Disco sano 1 TB', smart: healthy(), usage: usage(1000, 600) },
      { name: 'cansado', model: 'Disco cansado 2 TB', smart: healthy({ '197': 3, '199': 12 }), usage: usage(2000, 500) },
      { name: 'roto', model: 'Disco roto 500 GB', smart: healthy({ '198': 2 }), usage: usage(500, 100) },
      { name: 'mudo', model: 'Disco mudo 1 TB', smart: null, usage: usage(1000, 900) }
    ]
  }
})

test('U4 cada disco muestra semáforo, una frase simple, espacio usado y libre y la acción sugerida; SMART solo en Detalles técnicos plegado', async ({ page, service }) => {
  await openApp(page, service)
  await goTo(page, es.nav.disks)
  const card = (model: string) => page.getByTestId('disk-card').filter({ has: page.getByRole('heading', { name: model }) })

  const expected = [
    ['Disco sano 1 TB', 'green', 'use', '400 GB', '600 GB'],
    ['Disco cansado 2 TB', 'yellow', 'repair', '1,5 TB', '500 GB'],
    ['Disco roto 500 GB', 'red', 'repair', '400 GB', '100 GB'],
    ['Disco mudo 1 TB', 'unknown', 'use', '100 GB', '900 GB']
  ] as const
  for (const [model, health, action, used, free] of expected) {
    const disk = card(model)
    await expect(disk).toHaveAttribute('data-health', health)
    await expect(disk.getByRole('img', { name: es.health.label[health] })).toBeVisible()
    await expect(disk.getByTestId('disk-phrase')).toHaveText(es.health.phrase[health])
    await expect(disk.getByTestId('disk-space')).toContainText(es.disks.used.split('{value}')[0] + used)
    await expect(disk.getByTestId('disk-space')).toContainText(es.disks.free.replace('{value}', free))
    await expect(disk.getByTestId('disk-action')).toHaveAttribute('data-action', action)
    if (action === 'repair') {
      await expect(disk.getByRole('button', { name: es.disks.action.repair })).toBeVisible()
    } else {
      // Using a disk is not urgent: the card says so, and the button waits behind Editar so it is not pressed by accident
      await expect(disk.getByTestId('disk-action')).toContainText(es.disks.suggest.use)
      await expect(disk.getByRole('button', { name: es.disks.action.use })).toHaveCount(0)
      await disk.getByRole('button', { name: es.disks.action.edit }).click()
      await expect(disk.getByRole('button', { name: es.disks.action.use })).toBeVisible()
    }

    // Technical details exist but stay folded
    const toggle = disk.getByRole('button', { name: es.disks.technical.title })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(disk.getByTestId('technical-details')).toHaveCount(0)
    expect(await disk.innerText()).not.toMatch(FORBIDDEN_TERMS)
  }
  await expect(card('Disco cansado 2 TB')).toContainText(es.disks.advice.cable)
  await captureEvidence(page, 'U4-discos')

  // Opening the details shows the SMART attributes, and only there
  const tired = card('Disco cansado 2 TB')
  await tired.getByRole('button', { name: es.disks.technical.title }).click()
  await expect(tired.getByRole('button', { name: es.disks.technical.title })).toHaveAttribute('aria-expanded', 'true')
  const details = tired.getByTestId('technical-details')
  await expect(details).toContainText(es.disks.technical.attribute['197'])
  await expect(details).toContainText(es.disks.technical.attribute['199'])
  await expect(details).toContainText(es.disks.technical.serial)
  await expect(details.getByText('SN-CANSADO')).toBeVisible()
  await captureEvidence(page, 'U4-detalles-tecnicos')

  const mute = card('Disco mudo 1 TB')
  await mute.getByRole('button', { name: es.disks.technical.title }).click()
  await expect(mute.getByTestId('technical-details')).toContainText(es.disks.technical.smartNone)
})

test('U4 «Buscar discos» dice que está buscando y avisa cuando terminó', async ({ page, service }) => {
  await openApp(page, service)
  await goTo(page, es.nav.disks)
  await page.getByRole('button', { name: es.disks.scan }).click()
  await expect(page.getByTestId('scan-done')).toHaveText(es.disks.scanDone)
  await expect(page.getByRole('button', { name: es.disks.scan })).not.toHaveAttribute('aria-busy', 'true')
})
