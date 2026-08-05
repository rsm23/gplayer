import { RemoteStream } from '../stream/remote-stream.js'
import type { LoadBalancerHealthProbe } from './general-worker.js'

export class RemoteLoadBalancerHealthProbe implements LoadBalancerHealthProbe {
  public constructor(private readonly remote: Pick<RemoteStream, 'open'> = new RemoteStream()) {}

  public async status(target: URL, timeoutMilliseconds: number): Promise<number> {
    const response = await this.remote.open({
      url: target,
      method: 'GET',
      allowPrivateNetworks: true,
      maximumRedirects: 2,
      signal: AbortSignal.timeout(timeoutMilliseconds)
    })
    await response.body?.cancel().catch(() => undefined)
    return response.status
  }
}
