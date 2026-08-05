import type { HostingExtractor, MediaSource, MediaTrack } from '../core/source-resolver.js'

export abstract class BaseExtractor implements HostingExtractor {
  protected readonly sources: MediaSource[] = []
  protected readonly tracks: MediaTrack[] = []
  protected host = ''
  protected downloadable = false
  protected hlsMode = false
  protected email = ''
  protected referer = ''
  protected title = ''
  protected image = ''
  protected cookies: unknown[] = []
  protected filmstrip = ''
  protected networkInterface = ''

  public constructor(protected readonly id: string) {}

  public setHost(host: string): this { this.host = host; return this }
  public setDownloadable(downloadable: boolean): this { this.downloadable = downloadable; return this }
  public setHlsMode(enabled: boolean): this { this.hlsMode = enabled; return this }
  public setEmail(email: string): this { this.email = email; return this }
  public getSources(): Promise<readonly MediaSource[]> | readonly MediaSource[] { return this.sources }
  public getTracks(): Promise<readonly MediaTrack[]> | readonly MediaTrack[] { return this.tracks }
  public getReferer(): string { return this.referer }
  public getTitle(): string { return this.title }
  public getEmail(): string { return this.email }
  public getImage(): string { return this.image }
  public getCookies(): readonly unknown[] { return this.cookies }
  public getFilmstrip(): string { return this.filmstrip }
  public getNetworkInterface(): string { return this.networkInterface }
}
