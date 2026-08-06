import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { LEGACY_BACKGROUND_WORKER_RUNTIME } from '../src/drive/drive-background-worker.js'
import { ExtractorFactory } from '../src/hosting/extractor-factory.js'
import { PLAYER_LOADERS } from '../src/settings/player-settings.js'
import { hostingCases } from './fixtures/hosting-cases.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('generated legacy parity manifest', () => {
  it('captures the supplied 4.8.3 application surface', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'docs/parity-manifest.json'), 'utf8'))

    expect(manifest.source.version).toBe('4.8.3')
    expect(manifest.routes.frontend).toHaveLength(28)
    expect(manifest.routes.backend).toHaveLength(42)
    expect(manifest.features.hostingAdapters).toHaveLength(64)
    expect(manifest.features.databaseMigrations).toHaveLength(20)
    expect(manifest.features.backgroundWorkers).toHaveLength(6)
    expect(Object.keys(manifest.database.tables)).toHaveLength(20)
    expect(manifest.database.views).toEqual(['vw_loadbalancers', 'vw_subtitle_manager', 'vw_users', 'vw_videos'])
    expect(manifest.database.version).toBe(101)

    const inventoriedAdapters = manifest.features.hostingAdapters.map((name: string) => name.toLowerCase())
    const fixtureAdapters = hostingCases.map(([host]) => host)
    expect(inventoriedAdapters.filter((adapter: string) => adapter !== 'xvs').sort()).toEqual([...fixtureAdapters].sort())
  })

  it('maps every supplied backend view to a registered Node route and test', async () => {
    type AdminRoute = Readonly<{ legacy: string; method: 'GET' | 'POST'; replacement: string; sourceFile: string; testFile: string }>
    const [manifest, map] = await Promise.all([
      fs.readFile(path.join(projectRoot, 'docs/parity-manifest.json'), 'utf8').then((value) => JSON.parse(value)),
      fs.readFile(path.join(projectRoot, 'docs/admin-parity-map.json'), 'utf8').then((value) => JSON.parse(value) as { legacyRoutes: AdminRoute[]; ajaxControllers: AdminRoute[] })
    ])
    expect(map.legacyRoutes.map((entry) => entry.legacy).sort()).toEqual([...manifest.routes.backend].sort())
    expect(map.ajaxControllers.map((entry) => entry.legacy).sort()).toEqual([...manifest.routes.ajaxControllers].sort())
    for (const entry of [...map.legacyRoutes, ...map.ajaxControllers]) {
      if (map.legacyRoutes.includes(entry)) expect(entry.replacement).toBe(`/administrator/${entry.legacy}/`)
      await expect(fs.access(path.join(projectRoot, entry.sourceFile))).resolves.toBeUndefined()
      await expect(fs.access(path.join(projectRoot, entry.testFile))).resolves.toBeUndefined()
    }

    const app = await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: '1234567890123456' }))
    try {
      await app.ready()
      for (const entry of [...map.legacyRoutes, ...map.ajaxControllers]) expect(app.hasRoute({ method: entry.method, url: entry.replacement }), `${entry.method} ${entry.replacement}`).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('maps every supplied background entry point to a tested Node runtime', async () => {
    type BackgroundMap = Readonly<{ legacy: string; coordinatorJob: string; runtime: string; sourceFile: string; testFile: string }>
    const [manifest, map] = await Promise.all([
      fs.readFile(path.join(projectRoot, 'docs/parity-manifest.json'), 'utf8').then((value) => JSON.parse(value)),
      fs.readFile(path.join(projectRoot, 'docs/background-parity-map.json'), 'utf8').then((value) => JSON.parse(value) as { legacyWorkers: BackgroundMap[] })
    ])
    expect(map.legacyWorkers.map((entry) => entry.legacy).sort()).toEqual([...manifest.features.backgroundWorkers].sort())
    expect(Object.fromEntries(map.legacyWorkers.map((entry) => [entry.legacy, entry.coordinatorJob]))).toEqual(LEGACY_BACKGROUND_WORKER_RUNTIME)
    for (const entry of map.legacyWorkers) {
      expect(entry.runtime).not.toBe('')
      await expect(fs.access(path.join(projectRoot, entry.sourceFile))).resolves.toBeUndefined()
      await expect(fs.access(path.join(projectRoot, entry.testFile))).resolves.toBeUndefined()
    }
  })

  it('maps every supplied default-theme file to a registered and tested Node surface', async () => {
    type ThemeMap = Readonly<{
      legacy: string
      runtime: string
      route?: string
      replacementFiles: readonly string[]
      testFile: string
    }>
    const [manifest, map] = await Promise.all([
      fs.readFile(path.join(projectRoot, 'docs/parity-manifest.json'), 'utf8').then((value) => JSON.parse(value)),
      fs.readFile(path.join(projectRoot, 'docs/theme-parity-map.json'), 'utf8').then((value) => JSON.parse(value) as {
        bundledThemes: { backend: string[]; frontend: string[] }
        legacyThemeFiles: ThemeMap[]
      })
    ])
    expect(map.bundledThemes).toEqual({ backend: ['default'], frontend: ['default'] })
    expect(map.legacyThemeFiles.map((entry) => entry.legacy).sort()).toEqual([...manifest.features.themes].sort())
    for (const entry of map.legacyThemeFiles) {
      expect(entry.runtime).not.toBe('')
      expect(entry.replacementFiles.length).toBeGreaterThan(0)
      for (const replacement of entry.replacementFiles) {
        await expect(fs.access(path.join(projectRoot, replacement))).resolves.toBeUndefined()
      }
      await expect(fs.access(path.join(projectRoot, entry.testFile))).resolves.toBeUndefined()
    }

    const app = await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: '1234567890123456' }))
    try {
      await app.ready()
      for (const route of new Set(map.legacyThemeFiles.flatMap((entry) => entry.route === undefined ? [] : [entry.route]))) {
        expect(app.hasRoute({ method: 'GET', url: route }), `GET ${route}`).toBe(true)
      }
    } finally {
      await app.close()
    }
  })

  it('maps every legacy browser and optional external workflow to tested Node code', async () => {
    type BrowserlessMap = Readonly<{ legacyClass: string; host: string; replacementFile: string; testFile: string }>
    type ExternalMap = Readonly<{ legacy: string; replacementFiles: readonly string[]; testFiles: readonly string[] }>
    const map = JSON.parse(await fs.readFile(path.join(projectRoot, 'docs/external-service-parity-map.json'), 'utf8')) as {
      browserlessAdapters: BrowserlessMap[]
      optionalTools: ExternalMap[]
      networkServices: ExternalMap[]
    }
    expect(map.browserlessAdapters.map((entry) => entry.legacyClass).sort()).toEqual([
      'Blogger', 'Cloudmailru', 'Dood', 'Facebook', 'Filemoon', 'Filesfm', 'Hxfile', 'Mediafire', 'Mstream', 'Navertv', 'Rumble', 'Voe'
    ])
    const supportedHosts = new Set(new ExtractorFactory().supportedHosts())
    for (const entry of map.browserlessAdapters) {
      expect(supportedHosts.has(entry.host), entry.host).toBe(true)
      await expect(fs.access(path.join(projectRoot, entry.replacementFile))).resolves.toBeUndefined()
      await expect(fs.access(path.join(projectRoot, entry.testFile))).resolves.toBeUndefined()
      const implementation = await fs.readFile(path.join(projectRoot, entry.replacementFile), 'utf8')
      expect(implementation).not.toMatch(/puppeteer|playwright|selenium|HeadlessChrome/iu)
    }
    expect(map.optionalTools.map((entry) => entry.legacy).sort()).toEqual([
      'HeadlessChrome', 'PowerShell system metrics', 'YtdlpBridge', 'aria2c', 'shell port and connection enumeration'
    ])
    expect(map.networkServices.map((entry) => entry.legacy).sort()).toEqual([
      'Google reCAPTCHA verification', 'HTTP, HTTPS, SOCKS, and configured provider proxies', 'MaxMind GeoLite2 country and ASN lookup',
      'SMTP account mail', 'Subscene subtitle archive ingestion'
    ])
    for (const entry of [...map.optionalTools, ...map.networkServices]) {
      expect(entry.replacementFiles.length).toBeGreaterThan(0)
      expect(entry.testFiles.length).toBeGreaterThan(0)
      for (const file of [...entry.replacementFiles, ...entry.testFiles]) {
        await expect(fs.access(path.join(projectRoot, file))).resolves.toBeUndefined()
      }
    }
    const packageJson = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8')
    expect(packageJson).not.toMatch(/puppeteer|playwright|selenium|yt-dlp|youtube-dl|aria2c/iu)
  })

  it('maps every inventoried account model and account route to tested Node code', async () => {
    type LegacyClassMap = Readonly<{ legacyClass: string; publicMethods: readonly string[]; replacementFiles: readonly string[]; testFiles: readonly string[] }>
    type AccountRouteMap = Readonly<{ legacy: string; method: 'GET' | 'POST'; replacement: string; sourceFile: string; testFile: string }>
    type SecurityContractMap = Readonly<{ legacy: string; replacementFiles: readonly string[]; testFiles: readonly string[] }>
    const [manifest, map] = await Promise.all([
      fs.readFile(path.join(projectRoot, 'docs/parity-manifest.json'), 'utf8').then((value) => JSON.parse(value)),
      fs.readFile(path.join(projectRoot, 'docs/authentication-parity-map.json'), 'utf8').then((value) => JSON.parse(value) as {
        legacyClasses: LegacyClassMap[]
        accountRoutes: AccountRouteMap[]
        securityContracts: SecurityContractMap[]
      })
    ])
    expect(map.legacyClasses.map((entry) => entry.legacyClass).sort()).toEqual(['Mailer', 'SecurityHelper', 'Session', 'User'])
    for (const entry of map.legacyClasses) {
      const declaration = manifest.phpDeclarations.find((candidate: { className?: string }) => candidate.className === entry.legacyClass)
      expect(declaration, entry.legacyClass).toBeDefined()
      expect([...entry.publicMethods].sort()).toEqual([...(declaration.publicMethods as string[])].sort())
      for (const file of [...entry.replacementFiles, ...entry.testFiles]) {
        await expect(fs.access(path.join(projectRoot, file))).resolves.toBeUndefined()
      }
    }
    expect(map.accountRoutes.map((entry) => `${entry.method} ${entry.replacement}`).sort()).toEqual([
      'GET /administrator/ajax/sessions/', 'GET /administrator/login/', 'GET /administrator/profile/', 'GET /administrator/register/',
      'GET /administrator/register/resend/', 'GET /administrator/reset-password/', 'GET /administrator/users/sessions/',
      'POST /administrator/login/', 'POST /administrator/logout/', 'POST /administrator/profile/', 'POST /administrator/register/',
      'POST /administrator/register/resend/', 'POST /administrator/reset-password/', 'POST /administrator/users/sessions/delete/'
    ])
    const app = await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: '1234567890123456' }))
    try {
      await app.ready()
      for (const entry of map.accountRoutes) {
        expect(app.hasRoute({ method: entry.method, url: entry.replacement }), `${entry.method} ${entry.replacement}`).toBe(true)
        await expect(fs.access(path.join(projectRoot, entry.sourceFile))).resolves.toBeUndefined()
        await expect(fs.access(path.join(projectRoot, entry.testFile))).resolves.toBeUndefined()
      }
    } finally {
      await app.close()
    }
    for (const entry of map.securityContracts) {
      expect(entry.legacy).not.toBe('')
      for (const file of [...entry.replacementFiles, ...entry.testFiles]) {
        await expect(fs.access(path.join(projectRoot, file))).resolves.toBeUndefined()
      }
    }
  })

  it('maps the complete supplied player, embed, and download inventory to tested Node code', async () => {
    type LegacyClassMap = Readonly<{ legacyClass: string; publicMethods: readonly string[]; replacementFiles: readonly string[]; testFiles: readonly string[] }>
    type PlayerRouteMap = Readonly<{
      legacy: string
      methods: readonly ('GET' | 'POST')[]
      registeredPath: string
      replacementFiles: readonly string[]
      testFiles: readonly string[]
    }>
    type TemplateSurfaceMap = Readonly<{
      runtime: string
      legacyTemplates: readonly string[]
      replacementFiles: readonly string[]
      testFiles: readonly string[]
    }>
    const [manifest, map, embedCss] = await Promise.all([
      fs.readFile(path.join(projectRoot, 'docs/parity-manifest.json'), 'utf8').then((value) => JSON.parse(value)),
      fs.readFile(path.join(projectRoot, 'docs/player-parity-map.json'), 'utf8').then((value) => JSON.parse(value) as {
        legacyClasses: LegacyClassMap[]
        frontendRoutes: PlayerRouteMap[]
        templateSurfaces: TemplateSurfaceMap[]
        loaders: { names: string[]; replacementFiles: string[]; testFiles: string[] }
      }),
      fs.readFile(path.join(projectRoot, 'public/assets/css/gplayer-embed.css'), 'utf8')
    ])
    const playerFrontendRoutes = [
      'ads', 'api', 'api-config', 'download', 'embed', 'embed2', 'filmstrip', 'hls', 'mpd', 'poster', 'sharer',
      'stream-seg', 'stream-ts', 'stream-vid', 'subtitle'
    ]
    expect(map.frontendRoutes.map((entry) => entry.legacy).sort()).toEqual(playerFrontendRoutes)
    expect(manifest.routes.frontend.filter((route: string) => playerFrontendRoutes.includes(route)).sort()).toEqual(playerFrontendRoutes)

    const playerClasses = ['PublicAjax', 'SourceHelper', 'Video', 'VideoAlternative', 'VideoHash', 'VideoSource']
    expect(map.legacyClasses.map((entry) => entry.legacyClass).sort()).toEqual(playerClasses)
    for (const entry of map.legacyClasses) {
      const declaration = manifest.phpDeclarations.find((candidate: { className?: string }) => candidate.className === entry.legacyClass)
      expect(declaration, entry.legacyClass).toBeDefined()
      expect([...entry.publicMethods].sort()).toEqual([...(declaration.publicMethods as string[])].sort())
      for (const file of [...entry.replacementFiles, ...entry.testFiles]) {
        await expect(fs.access(path.join(projectRoot, file))).resolves.toBeUndefined()
      }
    }

    const widgetTemplates = new Set([
      'includes/templates/widget/blockadb.twig',
      'includes/templates/widget/default-script.twig',
      'includes/templates/widget/disqus.twig',
      'includes/templates/widget/ga.twig',
      'includes/templates/widget/gtm-body.twig',
      'includes/templates/widget/gtm-head.twig',
      'includes/templates/widget/histats.twig',
      'includes/templates/widget/link-example.twig',
      'includes/templates/widget/popupads.twig',
      'includes/templates/widget/recaptcha.twig',
      'includes/templates/widget/sharer.twig',
      'includes/templates/widget/vast.twig'
    ])
    const playerTemplates = manifest.features.twigTemplates.filter((template: string) =>
      template.startsWith('includes/templates/frontend/download/') ||
      template.startsWith('includes/templates/frontend/embed/') ||
      template.startsWith('includes/templates/frontend/loader/') ||
      template.startsWith('includes/templates/frontend/player-generator/') ||
      widgetTemplates.has(template)
    )
    const mappedTemplates = map.templateSurfaces.flatMap((entry) => entry.legacyTemplates)
    expect(mappedTemplates).toHaveLength(40)
    expect(new Set(mappedTemplates).size).toBe(mappedTemplates.length)
    expect([...mappedTemplates].sort()).toEqual([...playerTemplates].sort())
    for (const entry of map.templateSurfaces) {
      expect(entry.runtime).not.toBe('')
      expect(entry.legacyTemplates.length).toBeGreaterThan(0)
      for (const file of [...entry.replacementFiles, ...entry.testFiles]) {
        await expect(fs.access(path.join(projectRoot, file))).resolves.toBeUndefined()
      }
    }

    const legacyLoaderNames = playerTemplates
      .filter((template: string) => template.startsWith('includes/templates/frontend/loader/'))
      .map((template: string) => path.basename(template, '.twig'))
      .sort()
    expect([...map.loaders.names].sort()).toEqual(legacyLoaderNames)
    expect([...PLAYER_LOADERS].sort()).toEqual(legacyLoaderNames)
    for (const loader of PLAYER_LOADERS) expect(embedCss, loader).toContain(`.player-loader-${loader} `)
    for (const file of [...map.loaders.replacementFiles, ...map.loaders.testFiles]) {
      await expect(fs.access(path.join(projectRoot, file))).resolves.toBeUndefined()
    }

    const app = await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: '1234567890123456' }))
    try {
      await app.ready()
      for (const entry of map.frontendRoutes) {
        for (const method of entry.methods) {
          expect(app.hasRoute({ method, url: entry.registeredPath }), `${method} ${entry.registeredPath} for ${entry.legacy}`).toBe(true)
        }
        for (const file of [...entry.replacementFiles, ...entry.testFiles]) {
          await expect(fs.access(path.join(projectRoot, file))).resolves.toBeUndefined()
        }
      }
    } finally {
      await app.close()
    }
  })

  it('maps the complete supplied database inventory to schema-driven Node persistence', async () => {
    type LegacyClassMap = Readonly<{ legacyClass: string; publicMethods: readonly string[]; replacementFiles: readonly string[]; testFiles: readonly string[] }>
    type MigrationModelMap = Readonly<{
      legacyMigration: string
      migrationMethods: readonly string[]
      legacyModel: string
      modelMethods: readonly string[]
      table: string
      replacementFiles: readonly string[]
      testFiles: readonly string[]
    }>
    type ViewMap = Readonly<LegacyClassMap & { view: string }>
    const [manifest, map] = await Promise.all([
      fs.readFile(path.join(projectRoot, 'docs/parity-manifest.json'), 'utf8').then((value) => JSON.parse(value)),
      fs.readFile(path.join(projectRoot, 'docs/database-parity-map.json'), 'utf8').then((value) => JSON.parse(value) as {
        databaseInfrastructure: LegacyClassMap[]
        migrationModels: MigrationModelMap[]
        views: ViewMap[]
        schemaRuntime: {
          targetVersion: number
          schemaFiles: string[]
          implementationFiles: string[]
          testFiles: string[]
        }
      })
    ])
    const declaration = (className: string, filePrefix: string): { publicMethods: string[] } | undefined =>
      manifest.phpDeclarations.find((candidate: { className?: string; file?: string }) =>
        candidate.className === className && candidate.file?.startsWith(filePrefix))
    const expectMethods = (className: string, methods: readonly string[], filePrefix: string): void => {
      expect(declaration(className, filePrefix), className).toBeDefined()
      expect([...methods].sort()).toEqual([...(declaration(className, filePrefix)?.publicMethods ?? [])].sort())
    }
    const expectFiles = async (files: readonly string[]): Promise<void> => {
      for (const file of files) await expect(fs.access(path.join(projectRoot, file))).resolves.toBeUndefined()
    }

    expect(map.databaseInfrastructure.map((entry) => entry.legacyClass).sort()).toEqual([
      'Conn', 'Migrate', 'MigrateHelper', 'MigrationQueriesCreator', 'Model', 'ModelHelper'
    ])
    for (const entry of map.databaseInfrastructure) {
      expectMethods(entry.legacyClass, entry.publicMethods, 'includes/classes/Database/')
      await expectFiles([...entry.replacementFiles, ...entry.testFiles])
    }

    expect(map.migrationModels).toHaveLength(20)
    expect(new Set(map.migrationModels.map((entry) => entry.legacyMigration)).size).toBe(20)
    expect(new Set(map.migrationModels.map((entry) => entry.legacyModel)).size).toBe(20)
    expect(map.migrationModels.map((entry) => entry.legacyMigration).sort()).toEqual([...manifest.features.databaseMigrations].sort())
    expect(map.migrationModels.map((entry) => entry.table).sort()).toEqual(Object.keys(manifest.database.tables).sort())
    for (const entry of map.migrationModels) {
      expectMethods(entry.legacyMigration, entry.migrationMethods, 'includes/classes/Database/MySQL/Migration/')
      expectMethods(entry.legacyModel, entry.modelMethods, 'includes/classes/Model/')
      await expectFiles([...entry.replacementFiles, ...entry.testFiles])
    }

    expect(map.views.map((entry) => entry.legacyClass).sort()).toEqual([
      'ViewLoadBalancer', 'ViewSubtitleManager', 'ViewUser', 'ViewVideo'
    ])
    expect(map.views.map((entry) => entry.view).sort()).toEqual([...manifest.database.views].sort())
    for (const entry of map.views) {
      expectMethods(entry.legacyClass, entry.publicMethods, 'includes/classes/Model/')
      await expectFiles([...entry.replacementFiles, ...entry.testFiles])
    }

    expect(map.schemaRuntime.targetVersion).toBe(manifest.database.version)
    expect(map.schemaRuntime.schemaFiles.sort()).toEqual(['resources/mysql/mysql.sql', 'resources/mysql/views.sql'])
    await expectFiles([
      ...map.schemaRuntime.schemaFiles,
      ...map.schemaRuntime.implementationFiles,
      ...map.schemaRuntime.testFiles
    ])
  })
})
