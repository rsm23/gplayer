import type { HostingExtractor, HostingExtractorFactory } from '../core/source-resolver.js'
import { AparatExtractor } from './aparat.js'
import { AmazonExtractor, type AmazonExtractorOptions } from './amazon.js'
import { ArchiveExtractor } from './archive.js'
import { BloggerExtractor } from './blogger.js'
import { CloudMailRuExtractor } from './cloudmailru.js'
import { DailymotionExtractor, type DailymotionExtractorOptions } from './dailymotion.js'
import { createDirectProbe, DirectExtractor, type DirectProbe } from './direct.js'
import { DoodExtractor, type DoodExtractorOptions } from './dood.js'
import { DropboxExtractor } from './dropbox.js'
import { DzenExtractor } from './dzen.js'
import { FacebookExtractor } from './facebook.js'
import { FilesFmExtractor } from './filesfm.js'
import { FilemailExtractor } from './filemail.js'
import { FilemoonExtractor, type FilemoonExtractorOptions } from './filemoon.js'
import { FireloadExtractor } from './fireload.js'
import { GdriveExtractor } from './gdrive.js'
import { GofileExtractor } from './gofile.js'
import { GooglePhotosExtractor } from './googlephotos.js'
import { HxFileExtractor } from './hxfile.js'
import { MediaFireExtractor } from './mediafire.js'
import { MStreamExtractor } from './mstream.js'
import { MyMailRuExtractor } from './mymailru.js'
import { NaverTvExtractor } from './navertv.js'
import { OkruExtractor } from './okru.js'
import { PCloudExtractor } from './pcloud.js'
import { PixeldrainExtractor } from './pixeldrain.js'
import { RemoteProviderHttpClient, type ProviderHttpClient } from './provider-http.js'
import { RumbleExtractor } from './rumble.js'
import { SibnetExtractor } from './sibnet.js'
import { SoundcloudExtractor } from './soundcloud.js'
import { StreamableExtractor } from './streamable.js'
import { StreamtapeExtractor } from './streamtape.js'
import { TiktokExtractor } from './tiktok.js'
import { TurboVipPlayExtractor } from './turboviplay.js'
import { VimeoExtractor } from './vimeo.js'
import { VkExtractor } from './vk.js'
import { VidyardExtractor } from './vidyard.js'
import { VoeExtractor } from './voe.js'
import { VudeoExtractor } from './vudeo.js'
import { WetransferExtractor } from './wetransfer.js'
import { YourUploadExtractor } from './yourupload.js'
import { YandexDiskExtractor } from './yadisk.js'
import { XFileSharingExtractor, type XFileSharingConfig } from './xfile-sharing.js'
import { YetiShareExtractor, type YetiShareConfig } from './yetishare.js'
import { YoutubeExtractor, YoutubeInnertubeClient, type YoutubeClient } from './youtube.js'

export type ExtractorConstructor = (id: string) => HostingExtractor

export class ExtractorFactory implements HostingExtractorFactory {
  readonly #constructors = new Map<string, ExtractorConstructor>()

  public constructor(options: Readonly<{
    directProbe?: DirectProbe
    providerHttpClient?: ProviderHttpClient
    dailymotion?: DailymotionExtractorOptions
    dood?: DoodExtractorOptions
    amazon?: AmazonExtractorOptions
    filemoon?: FilemoonExtractorOptions
    youtube?: YoutubeClient
  }> = {}) {
    const providerHttpClient = options.providerHttpClient ?? new RemoteProviderHttpClient()
    this.register('aparat', (id) => new AparatExtractor(id, providerHttpClient))
    this.register('amazon', (id) => new AmazonExtractor(id, providerHttpClient, options.amazon ?? {}))
    this.register('archive', (id) => new ArchiveExtractor(id, providerHttpClient))
    this.register('blogger', (id) => new BloggerExtractor(id, providerHttpClient))
    this.register('cloudmailru', (id) => new CloudMailRuExtractor(id, providerHttpClient))
    this.register('direct', (id) => new DirectExtractor(id, options.directProbe ?? createDirectProbe(providerHttpClient)))
    this.register('dailymotion', (id) => new DailymotionExtractor(id, providerHttpClient, options.dailymotion ?? {}))
    this.register('dood', (id) => new DoodExtractor(id, providerHttpClient, options.dood ?? {}))
    this.register('facebook', (id) => new FacebookExtractor(id, providerHttpClient))
    this.register('pixeldrain', (id) => new PixeldrainExtractor(id, providerHttpClient))
    this.register('rumble', (id) => new RumbleExtractor(id, providerHttpClient))
    this.register('sibnet', (id) => new SibnetExtractor(id, providerHttpClient))
    this.register('soundcloud', (id) => new SoundcloudExtractor(id, providerHttpClient))
    this.register('streamable', (id) => new StreamableExtractor(id, providerHttpClient))
    this.register('streamtape', (id) => new StreamtapeExtractor(id, providerHttpClient))
    this.register('tiktok', (id) => new TiktokExtractor(id, providerHttpClient))
    this.register('vidyard', (id) => new VidyardExtractor(id, providerHttpClient))
    this.register('dropbox', (id) => new DropboxExtractor(id, providerHttpClient))
    this.register('dzen', (id) => new DzenExtractor(id, providerHttpClient))
    this.register('filesfm', (id) => new FilesFmExtractor(id, providerHttpClient))
    this.register('filemail', (id) => new FilemailExtractor(id, providerHttpClient))
    this.register('filemoon', (id) => new FilemoonExtractor(id, providerHttpClient, options.filemoon ?? {}))
    this.register('fireload', (id) => new FireloadExtractor(id, providerHttpClient))
    this.register('gdrive', (id) => new GdriveExtractor(id, providerHttpClient))
    this.register('gofile', (id) => new GofileExtractor(id, providerHttpClient))
    this.register('googlephotos', (id) => new GooglePhotosExtractor(id, providerHttpClient))
    this.register('hxfile', (id) => new HxFileExtractor(id, providerHttpClient))
    this.register('mediafire', (id) => new MediaFireExtractor(id, providerHttpClient))
    this.register('mstream', (id) => new MStreamExtractor(id, providerHttpClient))
    this.register('mymailru', (id) => new MyMailRuExtractor(id, providerHttpClient))
    this.register('navertv', (id) => new NaverTvExtractor(id, providerHttpClient))
    this.register('okru', (id) => new OkruExtractor(id, providerHttpClient))
    this.register('pcloud', (id) => new PCloudExtractor(id, providerHttpClient))
    this.register('vudeo', (id) => new VudeoExtractor(id, providerHttpClient))
    this.register('yourupload', (id) => new YourUploadExtractor(id, providerHttpClient))
    this.register('yadisk', (id) => new YandexDiskExtractor(id, providerHttpClient))
    this.register('turboviplay', (id) => new TurboVipPlayExtractor(id, providerHttpClient))
    this.register('vimeo', (id) => new VimeoExtractor(id, providerHttpClient))
    this.register('vk', (id) => new VkExtractor(id, providerHttpClient))
    this.register('voe', (id) => new VoeExtractor(id, providerHttpClient))
    this.register('wetransfer', (id) => new WetransferExtractor(id, providerHttpClient))
    const youtubeClient = options.youtube ?? new YoutubeInnertubeClient()
    this.register('youtube', (id) => new YoutubeExtractor(id, youtubeClient))
    for (const [host, config] of Object.entries(xFileSharingAdapters)) {
      this.register(host, (id) => new XFileSharingExtractor(id, providerHttpClient, config))
    }
    for (const [host, config] of Object.entries(yetiShareAdapters)) {
      this.register(host, (id) => new YetiShareExtractor(id, providerHttpClient, config))
    }
  }

  public register(host: string, constructor: ExtractorConstructor): this {
    this.#constructors.set(host.trim().toLowerCase(), constructor)
    return this
  }

  public create(host: string, id: string): HostingExtractor | null {
    return this.#constructors.get(host.trim().toLowerCase())?.(id) ?? null
  }

  public supportedHosts(): readonly string[] {
    return Object.freeze([...this.#constructors.keys()].sort())
  }
}

const xFileSharingAdapters: Readonly<Record<string, XFileSharingConfig>> = Object.freeze({
  earnvids: {
    embedUrl: (id) => `https://morencius.com/embed/${encodeURIComponent(id)}`,
    titleUrl: (id) => `https://morencius.com/file/${encodeURIComponent(id)}`
  },
  fileupload: {
    embedUrl: (id) => `https://www.file-upload.org/embed-${encodeURIComponent(id)}.html`,
    titleUrl: (id) => `https://www.file-upload.org/${encodeURIComponent(id)}`
  },
  goodstream: {
    embedUrl: (id) => `https://goodstream.one/${encodeURIComponent(id)}`,
    titleUrl: (id) => `https://goodstream.one/${encodeURIComponent(id)}`
  },
  hexupload: {
    embedUrl: (id) => `https://hexupload.net/embed-${encodeURIComponent(id)}.html`,
    titleUrl: (id) => `https://hexupload.net/${encodeURIComponent(id)}`
  },
  krakenfiles: {
    embedUrl: (id) => `https://krakenfiles.com/embed-video/${encodeURIComponent(id)}`,
    titleUrl: (id) => `https://krakenfiles.com/view/${encodeURIComponent(id)}/file.html`
  },
  lulustream: {
    embedUrl: (id) => `https://luluvdo.com/e/${encodeURIComponent(id)}`,
    titleUrl: (id) => `https://luluvdo.com/d/${encodeURIComponent(id)}`
  },
  mediacm: {
    embedUrl: (id) => `https://media.cm/e/${encodeURIComponent(id)}`,
    titleUrl: (id) => `https://media.cm/${encodeURIComponent(id)}`
  },
  mixdrop: {
    embedUrl: (id) => `https://mixdrop.ag/e/${encodeURIComponent(id)}`,
    titleUrl: (id) => `https://mixdrop.ag/f/${encodeURIComponent(id)}`
  },
  mp4upload: {
    embedUrl: (id) => `https://www.mp4upload.com/embed-${encodeURIComponent(id)}.html`,
    titleUrl: (id) => `https://www.mp4upload.com/${encodeURIComponent(id)}`
  },
  nossoplayer: {
    embedUrl: (id) => `https://nossoplayeronlinehd.org/tv/${encodeURIComponent(id)}`,
    referer: 'https://rdcplayer.online/',
    allowedResponseHosts: ['nossoplayeronlinehd.org']
  },
  sendvid: {
    embedUrl: (id) => `https://sendvid.com/embed/${encodeURIComponent(id)}`,
    titleUrl: (id) => `https://sendvid.com/${encodeURIComponent(id)}`
  },
  supervideo: {
    embedUrl: (id) => `https://supervideo.cc/e/${encodeURIComponent(id)}`,
    titleUrl: (id) => `https://supervideo.cc/${encodeURIComponent(id)}`
  },
  thetube: {
    embedUrl: (id) => `https://www.the.tube/${encodeURIComponent(id)}`,
    titleUrl: (id) => `https://www.the.tube/${encodeURIComponent(id)}`
  },
  uqload: {
    embedUrl: (id) => `https://uqload.net/embed-${encodeURIComponent(id)}.html`
  },
  vidara: {
    embedUrl: (id) => `https://vidara.to/e/${encodeURIComponent(id)}`,
    titleUrl: (id) => `https://vidara.to/v/${encodeURIComponent(id)}`,
    allowedResponseHosts: ['vidara.to']
  },
  vidmoly: {
    embedUrl: (id) => `https://vidmoly.biz/embed-${encodeURIComponent(id)}.html`
  },
  vidoza: {
    embedUrl: (id) => `https://videzz.net/embed-${encodeURIComponent(id)}.html`,
    titleUrl: (id) => `https://videzz.net/${encodeURIComponent(id)}`
  },
  vtube: {
    embedUrl: (id) => `https://vtube.network/embed-${encodeURIComponent(id)}.html`,
    titleUrl: (id) => `https://vtube.network/${encodeURIComponent(id)}.html`
  }
})

const yetiShareAdapters: Readonly<Record<string, YetiShareConfig>> = Object.freeze({
  cyberfile: {
    pageUrl: (id) => `https://cyberfile.me/${encodeURIComponent(id)}`
  },
  iceyfile: {
    pageUrl: (id) => `https://iceyfile.com/${encodeURIComponent(id)}`
  },
  udrop: {
    pageUrl: (id) => `https://www.udrop.com/${encodeURIComponent(id)}`
  }
})
